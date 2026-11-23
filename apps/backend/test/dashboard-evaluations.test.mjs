import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectComparison } from '../dist/dashboard.js';

test('adjudicated reports distinguish narrative review from pending platform replay',()=>{
  const side={
    metrics:{accuracy:0.8},questions:[
      {id:'GQ-25',score:'platform_replay_required'},{id:'GQ-06',score:'review'}],
    conversations:[{id:'CC-E11',critical:true,steps:[{score:'platform_replay_required',
      checks:[{scope:'platform_replay',status:'unverified'}]}]}]
  };
  const reviewed={golden:{'GQ-25':{correct:true},'GQ-06':{correct:true}},
    critical:{'CC-E11':{passed:true}},unresolved_critical_ids:['CC-E11']};
  const result=projectComparison({baseline:side,proposed:side,review:reviewed});
  assert.equal(result.cases[0].candidate,'platform_replay_required');
  assert.equal(result.cases[1].candidate,'verified_exact');
  assert.equal(result.cases[2].candidate,'platform_replay_required');
  assert.equal(result.cases[2].human_review,false);
  const released=projectComparison({baseline:side,proposed:side,review:{
    ...reviewed,platform_verified_ids:['CC-E11'],unresolved_critical_ids:[]
  }});
  assert.equal(released.cases[2].candidate,'verified_exact');
});

test('golden source proof remains in review until a human evaluates the answer',()=>{
  const side={metrics:{accuracy:0},questions:[{id:'GQ-25',score:'platform_replay_required'}],conversations:[]};
  const report={baseline:side,proposed:side,review:{platform_verified_golden_ids:['GQ-25']}};
  const pending=projectComparison(report).cases[0];
  assert.equal(pending.candidate,'review');
  assert.equal(pending.human_review,true);
  const reviewed=projectComparison({...report,review:{...report.review,golden:{'GQ-25':{correct:true}}}}).cases[0];
  assert.equal(reviewed.candidate,'verified_exact');
  assert.equal(reviewed.human_review,false);
});
