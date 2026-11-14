// Real host provider, isolated ordinary fixtures; no model calls or live profile.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {installPreset} from '../lib/presets.js';
import {readPresetDefinition} from '../lib/redteam/preset-composition.js';
const base=process.env.PURGE_TEST_HOST;if(!base)throw Error('Explicit isolated host components required');
const {FileSystemSkillProvider}=await import(pathToFileURL(path.join(base,'dsh-skill-filesystem/lib/index.js')));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'purge-native-skills-'));
const home=path.join(root,'home'),agents=path.join(root,'agents'),project=path.join(root,'project'),bundled=path.join(root,'bundled');
let provider;
try {
 fs.mkdirSync(home);fs.mkdirSync(project);fs.mkdirSync(path.join(project,'.git'));
 const roots=[path.join(home,'skills'),path.join(agents,'skills'),path.join(project,'.dsh/skills'),path.join(project,'.agents/skills'),bundled];
 roots.forEach((dir,i)=>{fs.mkdirSync(path.join(dir,'fixture-'+i),{recursive:true});fs.writeFileSync(path.join(dir,'fixture-'+i,'SKILL.md'),`---\nname: fixture-${i}\ndescription: Ordinary test fixture\n${i===1?'disable-model-invocation: true\n':''}---\nPlain fixture body ${i}\n`);});
 const {dir}=installPreset({home});const def=readPresetDefinition('unrestricted',dir);
 const config=def.plugins.find(row=>row.id==='skill-filesystem').config;
 provider=new FileSystemSkillProvider({get:()=>undefined,logger:{warn:message=>{throw Error(message);}}},{signal:new AbortController().signal,invalidate(){}},{...config,dshHome:home,agentsHome:agents,bundledSkillDir:bundled,watch:false});
 const result=await provider.list({cwd:project,signal:new AbortController().signal});
 assert(Array.isArray(result));assert.equal(result.length,5);assert.equal(new Set(result.map(c=>c.locator.path)).size,5);
 for(const candidate of result){const loaded=await provider.get(candidate,{signal:new AbortController().signal});assert.match(loaded.content,/Plain fixture body/);if(candidate.name==='fixture-1')assert.equal(loaded.invocation.modelInvocable,false);}
 console.log(JSON.stringify({realHostProvider:true,roots:5,duplicates:0,disabledModelInvocationPreserved:true,formalProfileTouched:false}));
}finally{await provider?.dispose();fs.rmSync(root,{recursive:true,force:true});}
