const { Menu, Plugin, PluginSettingTab, Setting, Notice, requestUrl, normalizePath, FileSystemAdapter } = require('obsidian');

const fs = require('fs').promises;

// 设置默认值
const DEFAULT_SETTINGS = {
  language: "en",
  enableUpload: true,
  altType: "none",
  serverUrl: "",
  uploadApi: "",
  imageQuailty: 40,
  applyImage: true, // 当剪贴板中存在文字和图片时，是否上传图片
  workOnNetWork: false, // 是否上传网络图片
  workDir: "", // 工作目录
};

const FRONTMATTER_KEY = "upload-image";

// 插件主体
module.exports = class MyPlugin extends Plugin {

  async onload() {
    console.log("Loading upload-image plugin");
    this.helper = new Helper(this.app);
    // 加载配置文件
    await this.loadSettings();

    // 添加状态栏
    this.addStatusBarItem().createEl("span", { text: "Hello status bar 👋" });

    // 添加配置面板
    this.addSettingTab(new UploadImageSettingTab(this.app, this, this.helper));
    this.setupPasteHandler();
    this.setupDragHandler();
    this.setupCommand();
  }
  onunload() {
    this.helper.cache.clear();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 注册剪贴板事件
  setupPasteHandler() {
    this.registerEvent(
      this.app.workspace.on(
        "editor-paste",
        (evt, editor, markdownView) => {
          const canUpload = this.helper.enablePlugin(this.settings)
          if (!canUpload) {
            return;
          }

          // 如果开启了自动转载网络图片到图床的话
          if (this.settings.workOnNetWork) {
            const clipboardValue = evt.clipboardData.getData("text/plain");
            const imageList = this.helper
              .getImageLink(clipboardValue)
              .filter(image => image.path.startsWith("http"))
              .filter(
                image =>
                  !this.helper.hasBlackDomain(
                    image.path,
                    this.settings.serverUrl
                  )
              );

            if (imageList.length !== 0) {
              this.updateNetworkImages(imageList, editor);
            }
          }

          // 剪贴板内容是图片时进行上传
          if (!this.helper.hitClipboard(evt.clipboardData)) {
            return;
          }

          evt.preventDefault();
          this.uploadFromFiles(editor, evt.clipboardData.files).catch();
        }
      )
    );
  }

  // 注册拖拽事件
  setupDragHandler() {
    this.registerEvent(
      this.app.workspace.on(
        "editor-drop",
        async (evt, editor, markdownView) => {
          const enableUpload = this.helper.enablePlugin(this.settings)
          // console.log("enableUpload", enableUpload);
          if (!enableUpload) {
            return;
          }

          // when ctrl key is pressed, do not upload image, because it is used to set local file
          if (evt.ctrlKey) {
            return;
          }

          const files = Array.from(evt.dataTransfer.files).filter(file => file.type.startsWith("image"));
          // console.log("files", files);
          if (files.length === 0) {
            return;
          }
          evt.preventDefault();
          this.uploadFromFiles(editor, files).catch();
        }
      )
    );
  }

  // 注册命令
  setupCommand() {
    this.addCommand({
      id: 'upload-image-delete',
      name: t('Delete uploaded image'),
      editorCallback: async (editor) => {
        const selection = editor.getSelection();

        let delSource = await new MyImageUploadServer(this).deleteImage(selection);
        // console.log("delSource", delSource);
        delSource.forEach(async (url) => {
          MyPlugin.replaceFirstOccurrence(editor, url, "", true);
        });
        if (delSource.length > 0) {
          this.helper.clear_cache();
        }

      },
    });
    this.addCommand({
      id: 'upload-image-current-md-file',
      name: t('Upload all local or network images in current file'),
      editorCallback: async (editor) => {
        let lines = editor.getValue();
        // console.log("lines", lines);
        // let exist = {};
        let networkList = [];
        this.helper.getImageLink(lines).forEach(async (image) => {
          if (image.path.startsWith("http")) {
            networkList.push(image);
          } else {
            const { base64, size, type } = await this.getImageBase64(image.path, false);

            this.uploadByBase64(image.path, this.helper.hash(base64)
              , size, type, base64,
              (url) => {
                this.replaceImage(editor, image, url);
                new Notice(`本地图片上传成功: ${image.path}`);
              },
              (e) => new Notice(e))
          }
        });


        // if (networkList.length > 0) {
        //   new Notice(`共发现${networkList.length}个网络图片，正在上传...`);
        //   await this.updateNetworkImages(networkList, editor);
        //   new Notice(`网络图片上传成功`);
        // }
      },
    });
  }


  // 从网络地址中获取图片的 base64 字符串
  async getImageBase64(url, fromNetwork = false) {
    // console.log("getImageBase64", url, fromNetwork);
    try {
      let buf;
      let type;
      if (fromNetwork) {
        // 使用 fetch 获取图片数据
        const response = await requestUrl(url);
        if (response.status !== 200) {
          throw new Error('网络请求失败');
        }

        // console.log('response', response);
        // console.log('type', response.headers['cntent-type']);
        // 读取出xhr响应的ArrayBuffer
        buf = response.arrayBuffer;
        type = response.headers['content-type']
      } else {
        buf = await this.helper.readFileAsArrayBuffer(url);
        // console.log('buf', buf);
      }

      if (!buf) {
        throw new Error('图片数据为空');
      }

      // 将ArrayBuffer转为Blob对象
      const blob = new Blob([buf], { type });
      // console.log('blob', blob);

      // 创建一个 FileReader 实例
      const reader = new FileReader();

      return new Promise((resolve, reject) => {
        // 当读取操作完成时
        reader.onloadend = () => {
          // 返回 base64 字符串
          resolve({ base64: reader.result, size: blob.size, type: blob.type });
        };

        // 读取 Blob 对象为 Data URL（base64）
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error('获取图片的 Base64 失败:', error);
      return null;
    }
  }

  /**
   * 从文件上传图片到服务器
   * 1. 生成临时文本
   * 2. 将图片转为base64
   * 3. 执行上传，得到图片链接
   * 4. 将临时文本替换为markdown格式的图片链接
   */
  async uploadFromFiles(editor, files) {
    if (files === undefined || files === null || files.length === 0) {
      return;
    }

    let sendFiles = [];
    Array.from(files).forEach((item, _index) => {
      sendFiles.push(item);
    });

    // 开始上传
    sendFiles.forEach(async (file) => {
      console.log("upload file", file);
      const name = file.name;
      let pasteId = (Math.random() + 1).toString(36).substr(2, 5);
      // 上传图片过程中，生成临时文本提示用户
      let progressText = MyPlugin.progressTextFor(pasteId);
      editor.replaceSelection(progressText + "\n\n");
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result;

        let path = this.helper.get_cache_key(file, base64);

        this.uploadByBase64(path, name, file.size, file.type, base64,
          (url) => this.embedMarkDownImage(editor, pasteId, url, name),
          (e) => this.handleFailedUpload(editor, pasteId, e)
        );
      };

      reader.onerror = (e) => {
        this.handleFailedUpload(editor, pasteId, e);
      };
      // 图片转base64
      reader.readAsDataURL(file);
    });
  }

  async uploadByBase64(path, name, size, type, base64
    , resolve = () => { }, reject = () => { }) {

    const hitCache = this.helper.hit_cache(path)
    if (hitCache) {
      resolve(hitCache);
      return;
    }

    // 执行上传
    try {
      const formData = {
        name,
        size,
        type,
        quality: this.settings.imageQuailty || 40,
        appid: this.settings.workDir || "",
        data: base64, // base64 放最后
      }

      // console.log('before 3.上传', formData);
      let res = await new MyImageUploadServer(this).uploadByClipboard(formData);
      if (res.code !== 0) {
        // this.handleFailedUpload(editor, pasteId, res.msg);
        reject(res.msg);
        return;
      }
      // console.log('3.上传', res);
      let url = res.data.url;
      // 去掉第一位，组合上服务器地址
      url = url.slice(1);
      url = `${this.settings.serverUrl}${url}`

      // this.embedMarkDownImage(editor, pasteId, url, name);
      this.helper.set_cache(path, url);
      resolve(url);
    } catch (e) {
      // this.handleFailedUpload(editor, pasteId, e);
      reject(e);
    }
  }

  async updateNetworkImages(imageList = [], editor) {
    if (imageList.length === 0) {
      return;
    }
    imageList.forEach(async (image) => {
      const { base64, size, type } = await this.getImageBase64(image.path, true);
      // console.log("base64", base64);
      if (base64) {
        new Notice(`正在上传网络图片: ${image.path}`);
        const name = image.name;
        this.uploadByBase64(image.path, name, size, type, base64,
          (url) => {
            this.replaceImage(editor, image, url);
            new Notice(`网络图片上传成功: ${url}`);
          },
          (e) => new Notice(e)
        );
      }
    })
  }

  /**
 * 替换上传的图片
 */
  replaceImage(editor, image, uploadUrl) {
    // let name = this.handleName(image.name);
    // const targetText = `![${name}](${uploadUrl})`;
    // console.log("replaceImage", image.path, uploadUrl);

    MyPlugin.replaceFirstOccurrence(
      editor,
      image.path, // image.source,
      uploadUrl, // targetText,
      true
    );

    if (this.settings.deleteSource) {
      if (image.file && !image.path.startsWith("http")) {
        this.app.fileManager.trashFile(image.file);
      }
    }
  }

  static progressTextFor(id) {
    return `![${t('🕔Uploading file...')}${id}]()`;
  }

  // 将临时文本替换为图片引用或失败提示
  static replaceFirstOccurrence(editor, target, replacement, replaceAll = false) {
    let lines = editor.getValue().split("\n");
    for (let i = 0; i < lines.length; i++) {
      let ch = lines[i].indexOf(target);
      if (ch != -1) {
        let from = { line: i, ch: ch };
        let to = { line: i, ch: ch + target.length };
        editor.replaceRange(replacement, from, to);
        if (!replaceAll) break;
      }
    }
  }

  // 生成 markdown 格式的图片引用
  embedMarkDownImage(editor, pasteId, imageUrl, name = "") {
    let progressText = MyPlugin.progressTextFor(pasteId);
    name = this.handleName(name);

    let markDownImage = `![${name}](${imageUrl})`;

    MyPlugin.replaceFirstOccurrence(
      editor,
      progressText,
      markDownImage
    );
  }

  handleFailedUpload(editor, pasteId, reason) {
    new Notice(reason);
    console.error("Failed request: ", reason);
    let progressText = MyPlugin.progressTextFor(pasteId);
    MyPlugin.replaceFirstOccurrence(
      editor,
      progressText,
      t("❌upload failed, check dev console")
    );
  }

  handleName(name) {
    const imageSize = this.settings.imageSize ? `|${this.settings.imageSize}` : "";
    const altType = this.settings.altType || "none";

    let altText = "";
    if (altType === "filename") {
      altText = name;
    } else if (altType === "custom") {
      altText = this.settings.altText || "";
    }
    return `${altText}${imageSize}`
  }

}

// 设置面板
class UploadImageSettingTab extends PluginSettingTab {
  constructor(app, plugin, helper) {
    super(app, plugin);
    this.plugin = plugin;
    this.helper = helper;
  }

  async display() {
    await this.plugin.loadSettings();
    let buf = await this.helper.readFileAsArrayBuffer(".obsidian/plugins/upload-image/favicon.ico");

    // 将ArrayBuffer转为Blob对象
    const blob = new Blob([buf], {});
    // console.log('blob', blob);

    // 创建一个 FileReader 实例
    const reader = new FileReader();
    // 读取 Blob 对象为 Data URL（base64）
    reader.readAsDataURL(blob);

    let { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Upload Image')
      .setHeading();

    let logo = containerEl.createEl('a', { 
      text: 'logo', 
      href: 'https://github.com/jachinq/upload-image', 
      target: '_blank' 
    })

    // 当读取操作完成时
    reader.onloadend = () => {
      let base64 = reader.result;
      logo.innerHTML = `<img src="${base64}" alt="logo">`;
    };

    // containerEl.createEl('h1', { text: t('Settings') });

    new Setting(containerEl)
      .setName(t('Basic Settings'))
      .setHeading();

    new Setting(containerEl)
      .setName(t('Language'))
      .setDesc(t('Choose your language'))
      .addDropdown(dropdown => {
        dropdown
          .addOption('zh', '简体中文')
          .addOption('en', 'English')
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            t.setLocale(value);
            this.plugin.settings.language = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName(t('Enable'))
      .setDesc(t('Open function, will be allow upload image by clipboard or drag and drop'))
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.enableUpload)
          .onChange(async (value) => {
            this.plugin.settings.enableUpload = value;
            await this.plugin.saveSettings();
          });
      });

    const workOnNetWorkDesc = t('Will be upload imager when clipboard is markdown image link, and ignore current server url');
    const workOnNetWorkDescEg = `eg: ![image](https://example.com/image.png) -> ![image](${this.plugin.settings.serverUrl}/image.png)`;
    new Setting(containerEl)
      .setName(t('Work On Network'))
      .setDesc(`${workOnNetWorkDesc}`)
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.workOnNetWork)
          .onChange(async (value) => {
            this.plugin.settings.workOnNetWork = value;
            await this.plugin.saveSettings();
          });
      });
    containerEl.createEl('span', { text: workOnNetWorkDescEg, cls: "setting-item-description" });
    containerEl.createEl('br');
    containerEl.createEl('br');

    new Setting(containerEl)
      .setName(t('Alt Text'))
      .setDesc(t('The alt text for the image, will be ignored for network images'))
      .addDropdown(dropdown => {
        dropdown
          .addOption('none', t('None'))
          .addOption('filename', t('Filename'))
          .addOption('custom', t('Custom'))
          .setValue(this.plugin.settings.altType)
          .onChange(async (value) => {
            this.plugin.settings.altType = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.altType === 'custom') {
      new Setting(containerEl)
        .setName(t('Custom Alt Text'))
        .setDesc(t('The custom alt text for the image'))
        .addText(text => {
          text.setPlaceholder('Custom Alt Text')
            .setValue(this.plugin.settings.altText)
            .onChange(async (value) => {
              this.plugin.settings.altText = value;
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName(t('Image Size'))
      .setDesc(t('The default size of the image'))
      .addText(text => {
        text.setPlaceholder('300')
          .setValue(this.plugin.settings.imageSize)
          .onChange(async (value) => {
            this.plugin.settings.imageSize = value;
            await this.plugin.saveSettings();
          });
      });


    new Setting(containerEl)
      .setName(t('Server Settings'))
      .setHeading();

    new Setting(containerEl)
      .setName(t('Server Url'))
      .setDesc(t('The image server url, not end with /'))
      .addText(text => {
        text.setPlaceholder('http://localhost:3000')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('Upload Api'))
      .setDesc(t('Will be concatenated with serverUrl to form the final upload url, start with /'))
      .setHeading('Upload Api')
      .addText(text => {
        text.setPlaceholder('/upload')
          .setValue(this.plugin.settings.uploadApi)
          .onChange(async (value) => {
            this.plugin.settings.uploadApi = value;
            await this.plugin.saveSettings();
          });
      });

    // if (this.plugin.settings.serverUrl && this.plugin.settings.uploadApi) {
    //   const finalUrl = `${this.plugin.settings.serverUrl}${this.plugin.settings.uploadApi}`;
    //   new Setting(containerEl)
    //     .setDesc(`${t('Current upload url: ')}${finalUrl}`)
    // }

    new Setting(containerEl)
      .setName(t('Image Quality'))
      .setDesc(t('The quality of the image'))
      .addText(text => {
        text.setPlaceholder('40')
          .setValue(this.plugin.settings.imageQuailty)
          .onChange(async (value) => {
            this.plugin.settings.imageQuailty = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('Work Directory'))
      .setDesc(t('Will upload images to this directory on the server, empty means root resource directory'))
      .addText(text => {
        text.setValue(this.plugin.settings.workDir)
          .onChange(async (value) => {
            this.plugin.settings.workDir = value;
            await this.plugin.saveSettings();
          });
      });

  }
}

const REGEX_FILE =
  /\!\[(.*?)\]\(<(\S+\.\w+)>\)|\!\[(.*?)\]\((\S+\.\w+)(?:\s+"[^"]*")?\)|\!\[(.*?)\]\((https?:\/\/.*?)\)/g;
const REGEX_WIKI_FILE = /\!\[\[(.*?)(\s*?\|.*?)?\]\]/g;
class Helper {
  constructor(app) {
    this.app = app;
    this.cache = new Map();
  }


  hash(str) {
    return str.split("").reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0).toString(36);
  }

  get_cache_key(file, base64) {
    let key = file.path;
    // 剪贴板的内容, 文件不存在 path, 需要根据base64生成一个唯一id
    if (key === undefined || key === null || key === "") {
      key = this.hash(base64) + ".png";
    }
    return key;
  }

  set_cache(path, value) {
    // console.log('set cache', path, this.cache);
    this.cache.set(path, value);
  }

  del_cache(path, base64) {
    // console.log('set cache', path, this.cache);
    this.cache.delete(path);
  }

  clear_cache(path, base64) {
    // console.log('set cache', path, this.cache);
    this.cache.clear();
  }

  hit_cache(path) {
    const url = this.cache.get(path);
    if (url) {
      console.log('hit cache', path, url, this.cache);
    }
    return url;
  }

  enablePlugin({ enableUpload, serverUrl, uploadApi }) {
    // 优先级最高 看当前文档 fmt 字段是否配置了上传功能
    const enableCurrentFmt = this.getFrontmatterValue(FRONTMATTER_KEY, false);
    if (enableCurrentFmt === true) {
      return true;
    }

    // 需要启用功能
    if (enableUpload === undefined || enableUpload === null || enableUpload === false) {
      return false;
    }
    // 需要配置好服务器地址和上传接口
    if (serverUrl === undefined || serverUrl === ""
      || uploadApi === undefined || uploadApi === "") {
      // console.log("if you want to upload image, please set serverUrl");
      return false;
    }
    return true;
  }

  // 判断剪贴板中是否存在图片数据, 比如图片本身, 或者图片链接, 或图片文件等
  hitClipboard(clipboardData) {
    const files = clipboardData.files;
    const text = clipboardData.getData("text");
    console.log(files[0].type)

    const hasImageFile =
      files.length !== 0 && files[0].type.startsWith("image");
    if (hasImageFile) {
      if (!!text) {
        // 当剪贴板中同时存在文本和图片时，也允许上传
        return this.settings.applyImage || true;
      } else {
        return true;
      }
    } else {
      return false;
    }
  }

  getFrontmatterValue(key, defaultValue = undefined) {
    const file = this.app.workspace.getActiveFile();
    // console.log('file', file);
    if (!file) {
      return undefined;
    }
    const path = file.path;
    const cache = this.app.metadataCache.getCache(path);
    // console.log('cache', cache?.frontmatter);

    let value = defaultValue;
    if (cache?.frontmatter && cache.frontmatter.hasOwnProperty(key)) {
      value = cache.frontmatter[key];
    }
    return value;
  }

  getEditor() {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mdView) {
      return mdView.editor;
    } else {
      return null;
    }
  }

  getValue() {
    const editor = this.getEditor();
    return editor.getValue();
  }

  setValue(value) {
    const editor = this.getEditor();
    const { left, top } = editor.getScrollInfo();
    const position = editor.getCursor();

    editor.setValue(value);
    editor.scrollTo(left, top);
    editor.setCursor(position);
  }

  // get all file urls, include local and internet
  getAllFiles() {
    const editor = this.getEditor();
    let value = editor.getValue();
    return this.getImageLink(value);
  }

  getImageLink(value) {
    const matches = value.matchAll(REGEX_FILE);
    const WikiMatches = value.matchAll(REGEX_WIKI_FILE);

    let fileArray = [];
    // console.log("matches", matches);
    let set = new Set();

    for (const match of matches) {
      // console.log("match", match);
      const source = match[0];

      let name = match[1];
      let path = match[2];
      if (name === undefined) {
        name = match[3];
      }
      if (path === undefined) {
        path = match[4];
      }

      if (set.has(path)) {
        continue;
      }

      fileArray.push({
        path: path,
        name: name,
        source: source,
      });
      set.add(path);
    }

    for (const match of WikiMatches) {
      let name = parse(match[1]).name;
      const path = match[1];
      const source = match[0];
      if (match[2]) {
        name = `${name}${match[2]}`;
      }
      if (set.has(path)) {
        continue;
      }
      fileArray.push({
        path: path,
        name: name,
        source: source,
      });
      set.add(path);
    }

    // console.log("network link work;fileArray", fileArray);
    return fileArray;
  }

  hasBlackDomain(src, blackDomains) {
    if (blackDomains.trim() === "") {
      return false;
    }
    const blackDomainList = blackDomains.split(",").filter(item => item !== "");
    let url = new URL(src);
    const domain = url.hostname;

    return blackDomainList.some(blackDomain => domain.includes(blackDomain) || blackDomain.includes(domain));
  }

  async readFileAsArrayBuffer(filePath) {
    const basePath = this.app.vault.adapter.basePath;
    const file_path = normalizePath(basePath + "/" + filePath);
    console.log("readFileAsArrayBuffer", file_path,);

    try {
      // 读取文件内容
      const fileBuffer = await fs.readFile(file_path);
      // 将 Buffer 转换为 ArrayBuffer
      const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
      return arrayBuffer;
    } catch (error) {
      throw new Error('文件读取失败: ' + error.message);
    }
  }
}

class MyImageUploadServer {
  constructor(plugin) {
    this.settings = plugin.settings;
    this.plugin = plugin;
  }

  async uploadFileByData(fileList) {
    const payload_data = {
      list: [],
    };

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      payload_data["list"].push(file);
    }

    const [request_body, boundary_string] = await payloadGenerator(
      payload_data
    );

    const options = {
      method: "POST",
      url: this.settings.uploadServer,
      contentType: `multipart/form-data; boundary=----${boundary_string}`,
      body: request_body,
    };
    const response = await requestUrl(options);

    return response;
  }

  /**
   * 处理返回值
   */
  async handleResponse(response) {
    const data = await response.json();

    if (response.status !== 200) {
      console.error(response, data);
      return {
        success: false,
        msg: data.msg || data.message,
        result: [],
      };
    }

    if (data.success === false) {
      console.error(response, data);
      return {
        success: false,
        msg: data.msg || data.message,
        result: [],
      };
    }

    return data;
  }

  async uploadFiles(fileList) {
    const basePath = this.plugin.app.vault.adapter.getBasePath();

    const list = fileList.map(item => {
      if (typeof item === "string") {
        return item;
      }
      console.log('item', item);
      return normalizePath(join(basePath, item.path));
    });

    const response = await requestUrl({
      url: this.settings.uploadServer,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list: list }),
    });


    return this.handleResponse(response);
  }

  async uploadByClipboard(formData) {
    if (!this.settings.serverUrl || !this.settings.uploadApi) {
      return;
    }

    // response = await this.uploadFileByData(files);
    // change formData to query string
    const queryString = Object.keys(formData).map(key => `${key}=${formData[key]}`).join('&');

    const url = `${this.settings.serverUrl}${this.settings.uploadApi}`;
    const options = {
      method: "POST",
      // url,
      body: queryString,
    };
    // const response = await requestUrl(options);
    let response = await fetch(url, options);
    response = await this.handleResponse(response);
    console.log('response', response);
    return response;
  }

  // 删除已上传的图片
  async deleteImage(delPath) {

    const helper = new Helper(this.plugin.app);

    if (!helper.enablePlugin(this.settings)) {
      // console.log("delete image ????");
      new Notice("请先启用功能并且配置好服务器地址和上传接口");
      return;
    }

    let urls = helper.getImageLink(delPath)
      .filter(image => image.path.startsWith("http"))
      .filter(
        image =>
          helper.hasBlackDomain(
            image.path,
            this.settings.serverUrl
          )
      )
    const waitToDelUrls = urls.map(image => image.path.replace(this.settings.serverUrl, "."));
    let delUrls = [];
    console.log("urls", waitToDelUrls);

    const url = `${this.settings.serverUrl}/api/deleteAll?url=[${JSON.stringify(waitToDelUrls)}]`;
    let response = await fetch(url);
    response = await response.json();
    if (response.success) {
      delUrls = urls.map(image => image.source);
      new Notice(`${response.msg || "删除成功"} 数量: ${delUrls.length}`);
      console.log("delete image success", delUrls);
    } else {
      new Notice(response.msg || "删除失败");
      console.error("delete image failed", response);
    }
    return delUrls;
  }
}

const TRANSLATIONS = {
  "Settings": "设置",
  "Basic Settings": "基本设置",
  "Server Settings": "服务器设置",
  "Language": "语言",
  "Enable": "启用功能",
  "Work On Network": "自动上传网络图片",
  "Server Url": "服务器地址",
  "Upload Api": "上传API",
  "Alt Text": "替代文字",
  "None": "无",
  "Filename": "文件名",
  "Custom": "自定义",
  "Custom Alt Text": "自定义替代文字",
  "Image Size": "图片尺寸",
  "Image Quality": "图片质量",
  "Work Directory": "工作目录",
  "Choose your language": "选择你的语言",
  "Open function, will be allow upload image by clipboard or drag and drop":
    "开启此功能，将允许通过剪贴板或拖拽上传图片",
  "Will be upload imager when clipboard is markdown image link, and ignore current server url":
    "当剪贴板内容为markdown格式的图片链接时，将自动上传图片，忽略当前服务器地址",
  "The image server url, not end with /": "图片服务器地址，不要以/结尾",
  "Will be concatenated with serverUrl to form the final upload url, start with /":
    "将与服务器地址连接起来，形成最终的上传地址，以/开头",
  "Current upload url: ": "当前上传地址：",
  "The alt text for the image, will be ignored for network images": "图片的替代文字，对自动转载的网络图片无效",
  "The custom alt text for the image": "图片的自定义替代文字",
  "The default size of the image": "图片的默认尺寸，会以此尺寸显示图片",
  "The quality of the image": "图片的质量，取值范围为 10-100",
  "Upload error": "上传错误",
  "Allow upload image by clipboard": "允许通过剪贴板上传图片",
  "Will upload images to this directory on the server, empty means root resource directory":
    "将上传图片到服务器上的这个目录，留空表示根资源目录",
  "🕔Uploading file...": "🕔正在上传文件...",
  "❌upload failed, check dev console": "❌上传失败，请检查开发者工具",
  "Delete uploaded image": "删除已上传的图片",
  "Upload all local or network images in current file": "上传当前文件中的所有本地或网络图片",
}

const t = key => {
  if (t.locale === 'en') {
    return key;
  }
  return TRANSLATIONS[key];
}
t.locale = 'zh';
t.setLocale = (locale) => {
  t.locale = locale;
  // console.log('set locale to', t.locale);
}