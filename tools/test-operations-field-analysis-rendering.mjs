import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {analysisRecords,productRecords,selection}=require('../cloudfunctions/businessApi/test/helpers/field-analysis-fixtures');
const {buildFieldAnalysis}=require('../cloudfunctions/businessApi/lib/operations-field-analysis');
const {record}=require('../cloudfunctions/businessApi/test/helpers/field-analysis-fixtures');
const {fieldSource}=require('../cloudfunctions/businessApi/test/helpers/field-fixtures');
const {formatAnalysisPage}=require('../miniprogram/utils/operations-field-analysis');
const root=path.resolve(import.meta.dirname,'..','miniprogram'),compiler=process.env.WECHAT_WCC_PATH;
assert.ok(compiler && fs.existsSync(compiler),'Official WXML compiler required');
const file='components/operations-field-analysis/index.wxml';
function render(data,fileOverride=file) {
  const file=fileOverride;
  assert.ok(fs.existsSync(path.join(root,file)),'analysis component must provide a native view');
  const compiled=execFileSync(compiler,[file],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
  const ctx=vm.createContext({window:{},console});vm.runInContext(compiled,ctx,{timeout:5000});return ctx.$gwx(file)(data);
}
const all=n=>n && typeof n==='object'?[n,...(n.children||[]).flatMap(all)]:[];
const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
function page(rows,input){const {matchedNodeIds,...r}=buildFieldAnalysis(rows,input);return formatAnalysisPage({...r,schemaVersion:1,scope:'all',incomplete:false,totalCount:r.items.length,hasMore:false,nextCursor:''})}
test('collapsed nodes hide field contents, with gap and failure messages independent of empty data',()=>{
  const rows=analysisRecords(),nodes=page(rows,selection(rows,'catalog')).items;
  const tree=render({enabled:true,nodes,selectedId:'',panel:page(rows,selection(rows,'node')),catalogNotice:'部分最终数据尚未补齐',catalogError:'加载失败'});
  assert.ok(text(tree).includes('合成节点'));assert.ok(text(tree).includes('部分最终数据尚未补齐'));assert.ok(text(tree).includes('加载失败'));
  assert.ok(!text(tree).includes('填写 3'));
});
test('node bundles contain positive options and native show-all actions',()=>{
  const rows=analysisRecords(),panel=page(rows,selection(rows,'node'));
  const tree=render({enabled:true,nodes:page(rows,selection(rows,'catalog')).items,selectedId:panel.context.nodeGroupId,panel,pairOptions:panel.dimensionMetadata,linkOptions:[]});
  assert.ok(text(tree).includes('单选'));assert.ok(text(tree).includes('多选'));
  assert.ok(!all(tree).some(n=>n.attr?.class==='analysis-option' && text(n).includes('Z')));
});
test('actual tuples render compactly with explicit co-occurrence interpretation',()=>{
  const rows=analysisRecords(),panel=page(rows,selection(rows,'pair',['choice','tags']));
  const tree=render({enabled:true,nodes:[],selectedId:panel.context.nodeGroupId,panel});
  for(const expected of ['单选：A','多选：Y','2 次','100%','不代表因果关系'])assert.ok(text(tree).includes(expected),expected);
});
test('product attributes retain holes and offer attribute combinations without an empty fake tuple',()=>{
  const rows=productRecords(),link=rows[0].schema.linkages[0];
  const panel=page(rows,selection(rows,'product',[],{linkageId:link.id,filters:link.dimensionIds.slice(0,3).map((dimensionId,i)=>({dimensionId,value:['椅类','品牌甲','型号一'][i]}))}));
  const tree=render({enabled:true,nodes:[],selectedId:panel.context.nodeGroupId,panel,path:[{name:'型号',value:'型号一'}]});
  for(const expected of ['color','headrest','属性组合','返回上一级'])assert.ok(text(tree).includes(expected),expected);
  assert.ok(!text(tree).includes('unused1'));
});

test('preview renders ten options, all-items view renders the remaining observed options',()=>{
  const options=Array.from({length:12},(_,i)=>`合成选项${String(i).padStart(2,'0')}`);
  const rows=options.map((value,i)=>record(fieldSource({nodeId:`many-${i}`,node:{fieldDefinitions:[
    {fieldKey:'choice',name:'选项',type:'single_select',constraints:{options:[...options,'零次候选']}}]},values:[{fieldKey:'choice',value}]})));
  const panel=page(rows,selection(rows,'node'));
  const preview=text(render({enabled:true,nodes:[],selectedId:panel.context.nodeGroupId,panel}));
  assert.ok(preview.includes('查看全部 12 项'));assert.ok(!preview.includes('合成选项11'));assert.ok(!preview.includes('零次候选'));
  const complete=text(render({enabled:true,nodes:[],selectedId:panel.context.nodeGroupId,panel:page(rows,selection(rows,'field',['choice']))}));
  assert.ok(complete.includes('合成选项11'));assert.ok(!complete.includes('零次候选'));
});

test('model with no applicable attributes presents the explicit empty state',()=>{
  const source=structuredClone(productRecords()[0].source);
  source.node.fieldDefinitions[0].optionLinkage.rows=[[0,0,0,null,null,null,null,null]];
  source.feedback.fieldValues=source.feedback.fieldValues.filter(f=>['category','brand','model'].includes(f.fieldKey));
  const rows=[record(source)],link=rows[0].schema.linkages[0];
  const filters=link.dimensionIds.slice(0,3).map((dimensionId,i)=>({dimensionId,value:['椅类','品牌甲','型号一'][i]}));
  const panel=page(rows,selection(rows,'product',[],{linkageId:link.id,filters}));
  const tree=render({enabled:true,nodes:[],selectedId:panel.context.nodeGroupId,panel});
  assert.ok(text(tree).includes('当前型号没有适用属性'));assert.ok(!text(tree).includes('查看属性组合'));
});

test('tuple labels containing separators retain explicit dimension boundaries',()=>{
  const rows=[['A / B','C'],['A','B / C']].map(([a,b],i)=>record(fieldSource({nodeId:`separators-${i}`,node:{fieldDefinitions:[
    {fieldKey:'choice',name:'第一维度',type:'single_select',constraints:{options:['A / B','A']}},
    {fieldKey:'tags',name:'第二维度',type:'single_select',constraints:{options:['C','B / C']}}
  ]},values:[{fieldKey:'choice',value:a},{fieldKey:'tags',value:b}]})));
  const panel=page(rows,selection(rows,'pair',['choice','tags']));
  const tree=render({enabled:true,nodes:[],selectedId:panel.context.nodeGroupId,panel});
  const tuples=all(tree).filter(n=>n.attr?.class==='analysis-tuple');
  assert.equal(tuples.length,2);assert.notEqual(text(tuples[0]),text(tuples[1]));
  assert.ok(tuples.some(n=>text(n).includes('第一维度：A / B') && text(n).includes('第二维度：C')));
});

test('operations page wires analysis, permission and source invalidation events',()=>{
  const tree=render({fieldAnalysisEnabled:true,fieldAnalysisQuery:{startDate:'2026-09-01'},fieldAnalysisSessionEpoch:3},'pages/admin-operations/index.wxml');
  const component=all(tree).find(n=>n.tag==='wx-operations-field-analysis');assert.ok(component);
  assert.equal(component.attr.enabled,true);assert.equal(component.attr.sessionEpoch,3);
  assert.equal(component.attr['bind:analysischange'],'onFieldAnalysisChange');
  assert.equal(component.attr['bind:accessinvalid'],'onFieldAnalysisAccessInvalid');
  assert.equal(component.attr['bind:sourceinvalid'],'onFieldAnalysisSourceInvalid');
});
