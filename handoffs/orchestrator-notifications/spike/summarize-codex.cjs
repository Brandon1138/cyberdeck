const lines=require("fs").readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean);
for (const l of lines){const ts=l.slice(0,24);let j;try{j=JSON.parse(l.slice(25))}catch{console.log(ts,"RAW",l.slice(25,300));continue}
const it=j.item; if(it){console.log(ts,j.type,it.type,JSON.stringify(it.text??it.command??{tool:it.tool,server:it.server,args:it.arguments,result:it.result,status:it.status,out:it.aggregated_output,exit:it.exit_code}).slice(0,350))}
else console.log(ts,j.type,JSON.stringify(j).slice(0,300))}
