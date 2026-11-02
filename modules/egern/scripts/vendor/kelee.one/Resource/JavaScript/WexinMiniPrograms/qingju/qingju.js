// 引用链接: https://kelee.one/Resource/JavaScript/WexinMiniPrograms/qingju/qingju.js
let obj=JSON.parse($response.body);
delete obj.data.bannerInfoConfig ;
$done({body: JSON.stringify(obj)});