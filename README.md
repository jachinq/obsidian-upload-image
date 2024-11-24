# upload-image

English | [简体中文](README_zh.md)

This is a [Obsidian](https://obsidian.md/) plugin that uploads local images to the image hosting service and inserts them into the note.

## Installation

Download this repository, extract it to a folder, and copy it to the Obsidian plugin folder.

Depending on your operating system, the plugin folder path may be:

`Your Obsidian Vault/.obsidian/plugins`

## Conflicts

This plugin conflicts with the following plugins, please do not enable them at the same time.

- [obsidian-custom-attachment-location](https://github.com/RainCat1998/obsidian-custom-attachment-location) 

## Use

Fisrt Step: Enable the function in the settings, the plugin will automatically listen to the clipboard content, and recognize the clipboard content as an image when it is pasted, the plugin will automatically upload the image to the image hosting service and get the image link after successful upload. Finally, the image link will be inserted into the note.

## Settings

Basic settings:

- Language: Choose the language used by the plugin, currently supports Chinese and English
- Enable function: Whether to enable the function of this plugin
- Auto upload network images: Whether to automatically upload network images, after enabling this function, the plugin will automatically recognize network images and upload them, when pasting, if the content contains markdown image syntax, the plugin will automatically upload and replace the image link
- Alternate text: The prompt text displayed when the image fails to load
- Image size: Does not affect the size of the uploaded image, only affects the size of the image displayed in Obsidian, the syntax is `![|300](xxx)`, where 300 is the size of the image to be displayed

Server settings:

- Server Url: The address of the image hosting service, such as https://sm.ms, note that the end does not have a / symbol
- Upload API: The API address of the image hosting service, such as /api/upload, the final upload interface used is https://sm.ms/api/upload
- Image quality: It affects the quality of the uploaded image, the range of the value is 10-100, 100 means the original image is uploaded, the server does not compress the image
- Working directory: The path where the uploaded image is stored, leave it blank to use the default path, note that it should not end with /

## ToDo

- [x] Add local cache mechanism, detect path to avoid uploading the same image repeatedly, cache will be cleared when reloading or opening the vault
- [x] Add command to delete image, will call the service delete interface to clear the image
- [x] Add command to upload images in the current document to the image hosting service and replace the image link in the document

## License

MIT