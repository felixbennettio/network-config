// 引用链接: https://kelee.one/Resource/JavaScript/WexinMiniPrograms/lawson/lawson.js
let obj=JSON.parse($response.body);
delete obj.data.homeButtonList ;
delete obj.data.dysmorphismPictureList ;
$done({body: JSON.stringify(obj)});