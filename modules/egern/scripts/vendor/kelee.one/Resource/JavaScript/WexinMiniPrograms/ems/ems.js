// 引用链接: https://kelee.one/Resource/JavaScript/WexinMiniPrograms/ems/ems.js
let obj = JSON.parse($response.body);
obj.info.moduleJson = JSON.stringify(JSON.parse(obj.info.moduleJson).filter(item => !item.moduleName.includes("广告")));
$done({body: JSON.stringify(obj)});