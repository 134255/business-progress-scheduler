'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const file=path.join(__dirname,'../lib/field-recovery-budget.js')
const create=fs.existsSync(file)?require(file).createFieldRecoveryBudget:undefined
function budget(ms=5000){assert.equal(typeof create,'function','shared deadline capability missing');let n=10000;return {b:create({clock:()=>new Date(n),timeBudgetMs:ms}),set:v=>{n=v}}}
test('the shared deadline stops exactly at five seconds, not five seconds per lane',()=>{
  const h=budget();h.set(14999);h.b.check();assert.equal(h.b.remainingMs(),1)
  h.set(15000);assert.throws(()=>h.b.check(),{code:'FIELD_RECOVERY_BUDGET'})
})
test('wall-clock reversal cannot extend an already observed deadline',()=>{
  const h=budget();h.set(14900);assert.equal(h.b.remainingMs(),100);h.set(11000)
  assert.equal(h.b.remainingMs(),100);h.set(15001);assert.throws(()=>h.b.check())
})
test('zero budget permits no work',()=>{const h=budget(0);assert.throws(()=>h.b.check(),{code:'FIELD_RECOVERY_BUDGET'})})
test('invalid clock and overlong budget are refused',()=>{
  assert.equal(typeof create,'function');assert.throws(()=>create({clock:()=>new Date(NaN),timeBudgetMs:5000}))
  assert.throws(()=>create({clock:()=>new Date(),timeBudgetMs:5001}))
})
