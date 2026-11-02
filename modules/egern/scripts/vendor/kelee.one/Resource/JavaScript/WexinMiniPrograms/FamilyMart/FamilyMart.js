// 引用链接: https://kelee.one/Resource/JavaScript/WexinMiniPrograms/FamilyMart/FamilyMart.js
let obj=JSON.parse($response.body);
delete obj.data.topBanner ;
$done({body: JSON.stringify(obj)});