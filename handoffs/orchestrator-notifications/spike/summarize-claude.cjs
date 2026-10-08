const lines=require("fs").readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean);
for (const l of lines){const ts=l.slice(0,24);let j;try{j=JSON.parse(l.slice(25))}catch{console.log(ts,"RAW",l.slice(25,300));continue}
if(j.subtype==="thinking_tokens"||j.type==="rate_limit_event")continue;
if(j.type==="assistant"){for(const c of j.message.content){if(c.type==="thinking")continue;console.log(ts,"ASSIST",c.type,JSON.stringify(c.text??c.input??"").slice(0,300))}}
else if(j.type==="user"){const m=j.message.content;if(typeof m==="string"){console.log(ts,"USER-STR",m.slice(0,400));continue}for(const c of m){console.log(ts,"USER",c.type,c.is_error?"is_error":"",JSON.stringify(c.content??c.text).slice(0,400))}}
else if(j.type==="result")console.log(ts,"RESULT",j.subtype,j.num_turns,JSON.stringify(j.result))
else if(j.subtype==="init")console.log(ts,"init")
else console.log(ts,j.type,j.subtype,JSON.stringify({n:j.hook_name,o:j.output,e:j.stderr,x:j.exit_code,outcome:j.outcome}).slice(0,400))}
