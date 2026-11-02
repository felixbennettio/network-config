// 引用链接: https://kelee.one/Resource/JavaScript/WexinMiniPrograms/ming/ming.js
let obj=JSON.parse($response.body);
obj.data=[];
$done({body: JSON.stringify(obj)});