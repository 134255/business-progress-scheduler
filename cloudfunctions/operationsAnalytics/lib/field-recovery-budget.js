'use strict'
function createFieldRecoveryBudget({clock=()=>new Date(),timeBudgetMs=5000}={}) {
  if(typeof clock!=='function'||!Number.isSafeInteger(timeBudgetMs)||timeBudgetMs<0||timeBudgetMs>5000)throw new TypeError('invalid recovery budget')
  let high=-Infinity
  function time(){const value=clock();if(!(value instanceof Date)||!Number.isFinite(Date.prototype.getTime.call(value)))throw new TypeError('invalid clock');high=Math.max(high,Date.prototype.getTime.call(value));return high}
  const deadline=time()+timeBudgetMs
  function check(){if(time()>=deadline){const e=new Error('FIELD_RECOVERY_BUDGET');e.code='FIELD_RECOVERY_BUDGET';throw e}}
  return {time,check,remainingMs:()=>Math.max(0,deadline-time())}
}
module.exports={createFieldRecoveryBudget}
