// 引用链接: https://kelee.one/Resource/JavaScript/WexinMiniPrograms/T3/T3.js
let obj = JSON.parse($response.body);
delete obj.data;
$done({body: JSON.stringify(obj)});
