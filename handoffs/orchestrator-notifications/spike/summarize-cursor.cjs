const lines=require("fs").readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean);
for (const l of lines){const ts=l.slice(0,24);let j;try{j=JSON.parse(l.slice(25))}catch{console.log(ts,"RAW",l.slice(25,300));continue}
if(j.type==="assistant"){console.log(ts,"ASSIST",JSON.stringify(j.message?.content?.map(c=>c.text??c.type)).slice(0,300))}
else if(j.type==="tool_call"){console.log(ts,"TOOL",j.subtype,JSON.stringify(j.tool_call).slice(0,300))}
else if(j.type==="result"){console.log(ts,"RESULT",j.subtype,JSON.stringify(j.result).slice(0,400))}
else console.log(ts,j.type,j.subtype??"",JSON.stringify(j).slice(0,250))}
