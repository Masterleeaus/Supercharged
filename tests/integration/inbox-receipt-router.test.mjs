import test from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import express from 'express';
import {createReceiptRouter} from '../../server/modules/inbox/receipt-router.ts';
async function fixture(service){const app=express();app.use('/callback',createReceiptRouter({service,requireConfiguredProvider:(_req,_res,next)=>next()}));
 const s=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x));});
 return{request:(body,headers={})=>new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:s.address().port,path:'/callback/integration-1',method:'POST',headers:{'content-type':'application/json',...headers}},res=>{let buf='';res.on('data',x=>buf+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(buf)}))});r.on('error',reject);r.end(body);}),close:()=>new Promise(resolve=>s.close(resolve))};
}
test('route passes raw unmodified JSON to receipt verifier',async()=>{
 let observed;const f=await fixture({receive:async input=>{observed=input;return 'recorded'}});
 try{const body='{"x": 1}';const response=await f.request(body);assert.equal(response.status,200);assert.equal(observed.rawBody.toString(),body);assert.equal(observed.integrationId,'integration-1');}finally{await f.close();}
});
test('route never reports invalid signature as a successful callback',async()=>{
 const {InvalidProviderSignature}=await import('../../server/modules/inbox/provider-signature.ts');
 const f=await fixture({receive:async()=>{throw new InvalidProviderSignature()}});
 try{const res=await f.request('{}');assert.equal(res.status,401);}finally{await f.close();}
});
test('unknown delivery references remain unconfirmed',async()=>{
 const f=await fixture({receive:async()=> 'unmatched'});
 try{const res=await f.request('{}');assert.equal(res.status,202);}finally{await f.close();}
});
