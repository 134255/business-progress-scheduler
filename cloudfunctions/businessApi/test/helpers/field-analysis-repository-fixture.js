const {createFakeCloudDatabase}=require('./fake-cloud-database')
const {createCloudOperationsFieldRepository}=require('../../lib/cloud-operations-field-repository')
const {analysisRecords,selection}=require('./field-analysis-fixtures')
const {normalizeFieldQuery}=require('../../lib/operations-field-service')
const now=new Date('2026-09-23T00:00:00Z')
const admin={_id:'root',role:'super_admin',status:'active'},staff={_id:'staff',role:'user',status:'active'}
function analysisHarness(options={}) {
  const records=analysisRecords()
  const sources=records.map((r,i)=>{
    const s=structuredClone(r.source);s.line._id=`line-${i}`;s.line.memberUserIds=i?['root']:['staff'];s.line.managerUserIds=['root']
    s.node.businessLineId=s.line._id;s.feedback.businessLineId=s.line._id;return s
  })
  const fake=createFakeCloudDatabase({users:[admin,staff],business_lines:sources.map(s=>s.line),business_nodes:sources.map(s=>s.node),
    node_feedback:sources.map(s=>s.feedback),node_review_rounds:[],node_review_votes:[],operations_field_snapshots:[]},options)
  const baseRanges=[]
  const repository=createCloudOperationsFieldRepository({db:fake.db,secret:'synthetic-analysis-secret-'.repeat(3),clock:()=>now,
    operationsRepository:{async collectReportBase({range}){baseRanges.push(range);if(options.onBaseRead) options.onBaseRead({fake,sources});
      return {items:[{businessCode:'BL-BASE',nodeCode:'BL-BASE-N1',processingElapsedWorkMinutes:7}],manifest:{lines:[],nodes:[]}}},
    async validateReportBase({range}){baseRanges.push(range)}}})
  const range={...normalizeFieldQuery({startDate:'2026-09-01',endDate:'2026-09-23'},now),analysis:selection(records,'node')}
  return {fake,repository,range,sources,records,baseRanges}
}
module.exports={analysisHarness,admin,staff}
