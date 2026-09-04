'use strict';

const { execFile } = require('child_process');

const PROXY = process.env.CATBOX_PROXY || 'http://192.168.100.1:7890';

/**
 * 上传文件到 catbox.moe（永久直链，单文件限 200MB），返回直链 URL。
 * catbox.moe 需翻墙，默认走 mihomo 代理（可用 CATBOX_PROXY 覆盖）。
 */
function uploadCatbox(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s',
      '--max-time', '180',
      '-x', PROXY,
      '-F', 'reqtype=fileupload',
      '-F', `fileToUpload=@${filePath}`,
      'https://catbox.moe/user/api.php',
    ];
    execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`catbox 上传失败: ${err.message}`));
      const data = (stdout || '').trim();
      if (data.startsWith('https://')) resolve(data);
      else reject(new Error(`catbox 返回异常: ${data.slice(0, 200)}`));
    });
  });
}

module.exports = { uploadCatbox };
