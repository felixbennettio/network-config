// 引用链接: https://kelee.one/Resource/JavaScript/WexinMiniPrograms/alittle-tea/alittle-tea.js
let obj=JSON.parse($response.body);
delete obj.data;
$done({body: JSON.stringify(obj)});