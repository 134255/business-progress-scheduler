const {analysisRecords,selection}=require('../../../cloudfunctions/businessApi/test/helpers/field-analysis-fixtures')
const {fieldAnalysisExportRows}=require('../../../cloudfunctions/businessApi/lib/operations-field-analysis')
function harness(overrides={}) {
  const records=analysisRecords(),app={globalData:{currentUser:{_id:'root',role:'super_admin',status:'active'}}}
  const calls=[],writes=[],shares=[];let page
  global.getApp=()=>app
  global.wx={env:{USER_DATA_PATH:'/synthetic'},reLaunch(){},getFileSystemManager:()=>({writeFile(v){writes.push(v);v.success()}}),
    shareFileMessage(v){shares.push(v)}}
  const filters={templates:[{templateId:'template-1',templateName:'合成模板'}],templateVersions:[1],stableNodes:[]}
  const handlers={getOperationsDashboard:()=>({stats:{}}),getOperationsAnalyticsFilters:()=>filters,getOperationsFieldFilters:()=>filters,
    getOperationsAnalyticsSummary:()=>({templateMetrics:{},nodeSeries:[],trendSeries:[]}),
    exportOperationsReportRows:query=>({items:fieldAnalysisExportRows(records,query.analysis).rows,hasMore:false,nextCursor:''}),...overrides}
  const files=['../utils/cloud','../services/business','../pages/admin-operations/index'].map(p=>require.resolve('../../'+p.slice(3)))
  const saved=files.map(f=>require.cache[f])
  require.cache[files[0]]={id:files[0],filename:files[0],loaded:true,exports:{async callBusinessApi(action,payload){calls.push({action,payload});return handlers[action](payload)}}}
  delete require.cache[files[1]];delete require.cache[files[2]]
  global.Page=d=>{page={...d,data:structuredClone(d.data),setData(update){Object.assign(this.data,update)}}}
  try{require(files[2])}finally{delete global.Page;files.forEach((f,i)=>{if(saved[i])require.cache[f]=saved[i];else delete require.cache[f]})}
  page.setData({startDate:'2026-09-01',endDate:'2026-09-23'})
  return {records,selection,app,page,calls,writes,shares}
}
module.exports={harness}
