import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readBackupPayload,mergeBackup,summarizeRestore} from '../src/restore-backup.js';

const backup={docs:[{id:'cloud-old',title:'旧书库文献',pages:9,sourcePages:[{id:'o1',order:1,name:'o1.png',text:'Old page.'}]}],
  cards:[{id:'card-1',type:'word',term:'inherit'},{id:'card-2',type:'word',term:'capital'}],
  deletedDocs:[{id:'gone',title:'已删文献'}],minutes:412,reviewed:30,settings:{glossary:'agency = 能动性'}};

test('a backup restores missing documents, cards and study totals',()=>{
  const {state,added,skipped}=mergeBackup({docs:[{id:'mine',title:'我的文献'}],cards:[],minutes:60,reviewed:5,settings:{auto:true}},readBackupPayload(backup));
  assert.deepEqual(added,{docs:1,cards:2,deleted:1});
  assert.deepEqual(skipped,{docs:0,cards:0});
  assert.deepEqual(state.docs.map(doc=>doc.id),['mine','cloud-old']);
  assert.deepEqual(state.deletedDocs.map(doc=>doc.id),['gone']);
  assert.ok(state.deletedDocs[0].deletedAt,'最近删除的文献必须带 deletedAt，否则同步会把它放回书架');
  assert.equal(state.minutes,412,'累计学习时长取较大值');
  assert.equal(state.reviewed,30);
});

test('existing entries keep the current version instead of being overwritten',()=>{
  const current={docs:[{id:'cloud-old',title:'我已经改过的标题',progress:88}],cards:[{id:'card-1',term:'inherit',meaning:'本机释义'}],
    deletedDocs:[],minutes:900,reviewed:0,settings:{glossary:'我的术语',auto:false}};
  const {state,added,skipped}=mergeBackup(current,readBackupPayload(backup));
  assert.equal(added.docs,0);
  assert.equal(skipped.docs,1);
  assert.equal(added.cards,1);
  assert.equal(skipped.cards,1);
  assert.equal(state.docs[0].title,'我已经改过的标题');
  assert.equal(state.cards.find(card=>card.id==='card-1').meaning,'本机释义');
  assert.equal(state.minutes,900,'备份里的旧时长不会把已有投入算少');
  assert.deepEqual(state.settings,{glossary:'我的术语',auto:false},'本机偏好优先，缺失项从备份补齐');
});

test('a document deleted in the backup is never put back on the shelf',()=>{
  const {state}=mergeBackup({docs:[{id:'keep'}],cards:[]},readBackupPayload({docs:[{id:'gone',title:'旧'}],deletedDocs:[{id:'gone',title:'旧'}]}));
  assert.deepEqual(state.docs.map(doc=>doc.id),['keep']);
  assert.deepEqual(state.deletedDocs.map(doc=>doc.id),['gone']);
  assert.ok(state.deletedDocs[0].deletedAt,'最近删除的文献必须带 deletedAt，否则同步会把它放回书架');
});

test('unusable files are rejected with a readable message',()=>{
  assert.throws(()=>readBackupPayload(null),/不是 Scribe 的学习数据备份/);
  assert.throws(()=>readBackupPayload({}),/没有可恢复的文献或学习卡/);
  assert.throws(()=>readBackupPayload({docs:[],cards:[],deletedDocs:[]}),/没有可恢复/);
  assert.deepEqual(readBackupPayload({state:{cards:[{id:'c'}]}}).cards,[{id:'c'}],'兼容包在 state 里的旧格式');
  assert.equal(readBackupPayload({cards:[{id:'c'}]}).minutes,0);
});

test('the summary explains what came back and what was left alone',()=>{
  assert.equal(summarizeRestore({docs:2,cards:3,deleted:0},{docs:1,cards:0}),'已恢复文献 2 本、学习卡 3 张；另有 1 项本机已存在，保留了当前版本。');
  assert.equal(summarizeRestore({docs:0,cards:0,deleted:0},{docs:2,cards:0}),'备份里的内容本机都已经有了，没有重复导入。');
});
