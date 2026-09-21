# 企微账号绑定与本人收件确认 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现管理员绑定企微成员、员工本人验证码确认及安全的独立验证消息发送能力，不启用业务催办。

**Architecture:** 原生小程序经现有 businessApi 鉴权完成绑定及挑战事务；独立云托管服务验证服务器签名、重新检查挑战、持久去重后才调用企微。共享纯规则只有一个源文件版本，云托管构建时显式复制，数据库 SDK 差异封装于适配器；站内通知与现有工作器不改。

**Tech Stack:** CommonJS、Node.js 内置 crypto/https/http、node:test、现有 wx-server-sdk 4.0.2 与 CloudBase 文档数据库、微信原生 WXML/WXSS。businessApi 保持现有 Node.js 16.13 兼容语法；新容器运行时及数据库 SDK 按任务 7 的官方契约门禁确定并锁定，不升级旧云函数依赖。

**Spec:** `docs/superpowers/specs/2026-09-21-wecom-binding-and-verification-design.md`（2026-09-21 用户已批准；执行者先读完整设计）。

状态：2026-09-21 用户选择“连续开发、最后统一复核”，批准本地实施；任务进度见本计划执行账本及STATUS。生产接入仍须独立授权，不创建云资源、不读取通讯录、不注入真实密钥、不发送消息、不变更备案申请、不推送 GitHub。

## Global Constraints

- 同一企业成员不能同时绑定两个小程序账号；同一小程序账号只能有一个企微接收身份。
- 管理员可查看待确认、已验证、暂停及需重新确认状态，并取消待绑定或解绑；不得替员工完成确认。
- 确认码采用加密安全随机生成的 6 位数字，有效期 5 分钟、单次消费、最多 5 次错误尝试；服务端只持久化带独立服务端密钥的摘要，不持久化或输出明文码。
- 同一账号及同一目标成员均至少间隔 60 秒才可重新发送，默认每小时最多 5 次；发起方也做独立限流，管理员不能通过重复改绑规避成员限流。计数和时间使用服务端时钟及事务。
- 重新发送生成新挑战并使旧码失效。发送超时显示“发送结果待确认”；已收到的有效码仍可验证，不自动重复推送验证码。用户明确重发前提示旧码将失效。
- 账号停用、解绑、改绑、密码重置等安全状态变化立即使在途挑战失效。恢复账号不自动开启企微提醒。
- 验证发送与后续业务提醒使用不同开关，任何一项失败均不影响现有业务保存、审核和站内通知。
- 本期不发送真实业务催办，不更改任何 Timer，不改业务、模板、权限或历史，不增加群发及客户通知。
- 已有 `project.config.json`、`outputs/deploy/`、`outputs/user-guides/`、`tools/__pycache__/` 是前置改动，不删除、不暂存。实施时通过 worktree 技能隔离；本轮仅写文档。
- 全部测试使用合成身份和假传输；密钥、验证码、原始企微响应、成员标识不得进入日志、Git、导出或项目记忆。

## Review Focus

1. 普通登录也会递增现有 `credentialVersion`，不能因此取消已验证绑定；密码重置和停用后恢复必须取消。任务 3 覆盖。
2. 管理员误填 `@all`、带 `|` 的成员列表或大小写变体，必须禁止广播并保持单成员唯一性；未经官方核对不得猜规范化。任务 1、2、7 覆盖。
3. 错误验证码事务抛异常回滚计数、或整点刷新限流导致暴力尝试，必须持久记次并采用滚动窗口。任务 4 覆盖。
4. 供应商接受后进程崩溃、旧成功响应晚于解绑或重发，不得自动重发、恢复旧状态或误报已送达。任务 6、8、11 覆盖。
5. 员工切换小程序账号、Mac 微信返回旧页或服务端绑定已经变化时，旧请求与输入不能泄漏到新账号。任务 9、10 覆盖。

## 现状、边界和依赖

基线为本地 `6de0615`，功能源码没有企微发送路径。`workflowReminder` 只生成站内通知；39 项既有测试的历史结果不能替代本轮回归。上一阶段只读看到个人版云托管固定出口开启但无服务；当前计划没有复查云端，也没有验证备案结果。

2026-09-21 复查官方企微发送页仍无法读取正文；CloudBase 固定出口文档本次抓取超时。官方 SDK 初始化文档能读取，提示新 Node 服务使用 `@cloudbase/js-sdk` v3，且函数型云托管 context 免签与普通容器不是一回事。因此真实数据库鉴权、SDK 写入形状和企微 UserID/消息格式属于显式阻断门禁，不能从云函数 SDK 或第三方镜像照搬。模拟层可先实现，真实适配器门禁未通过必须记录 blocked，不标为全部完成。

官方核对入口：

- https://developer.work.weixin.qq.com/document/path/90236
- https://docs.cloudbase.net/api-reference/webv3/initialization
- https://docs.cloudbase.net/api-reference/server/node-sdk/initialization
- https://docs.cloudbase.net/run/deploy/networking/staticip

计划分为两段：任务 1–11 是本地开发与验证；任务 12 是单独授权后的生产接入验收。任何一段未完成，都不能宣称“双端提醒已上线”。小时业务提醒及其队列是后续独立计划。

## 文件职责与依赖顺序

| 单元 | 新建路径 | 责任 |
| --- | --- | --- |
| 纯规则 | `cloudfunctions/businessApi/lib/wecom-domain.js`、`wecom-config.js`、`wecom-member-contract.js` | 状态投影、字段校验、摘要、限流、安全版本与配置；官方成员契约独立锁定 |
| 数据库公共层 | `cloudfunctions/businessApi/lib/wecom-store.js` | 固定文档事务及有类型的读写；不做供应商调用 |
| 事务服务 | `cloudfunctions/businessApi/lib/wecom-binding-repository.js`、`wecom-challenge-repository.js`、`wecom-delivery-repository.js` | 绑定唯一性、挑战计数、发送领取/结果 |
| 编排及签名 | `cloudfunctions/businessApi/lib/wecom-service.js`、`wecom-request-auth.js`、`wecom-sender-client.js` | 受保护方法、服务器签名与固定地址调用 |
| 云托管 | `cloudrun/wecom-notifier/server.js`、`lib/handler.js`、`lib/wecom-client.js`、`lib/database.js` | HTTP 边界、去重校验、企微适配器、SDK 适配器 |
| 构建与部署资料 | `cloudrun/wecom-notifier/package.json`、`package-lock.json`、`Dockerfile`、`.dockerignore`、`tools/build-wecom-notifier.mjs`、`docs/deployment/wecom-verification.md` | 可复现独立构建、精确依赖与放行清单 |
| 小程序服务及页面 | `miniprogram/services/wecom.js`、`miniprogram/utils/wecom-page-state.js`、`miniprogram/pages/admin-user-wecom/index.{js,json,wxml,wxss}`、`miniprogram/pages/wecom-reminders/index.{js,json,wxml,wxss}` | 管理入口、本人确认及请求隔离 |

修改现有文件：`cloudfunctions/businessApi/index.js`、`lib/cloud-account-repository.js`、`test/helpers/auth-harness.js`、`test/helpers/admin-user-harness.js`；`miniprogram/app.json`、`pages/admin-users/index.{js,wxml}`、`pages/profile/index.{js,wxml}`。测试在各项目既有 `test/` 下新增，不重构其他服务。下文路径省略的 `lib/`、`test/` 均在对应任务注明的项目根下。

顺序：1 → 2 → 3/4 → 5 → 6/7 → 8 → 9/10 → 11 → 12。不同时派遣多个写入者编辑 `businessApi/index.js` 或账号仓储。

## 固定接口与数据契约

时间在纯规则中为 UTC 毫秒安全整数，存储适配器显式转换 Date；版本非负安全整数，缺失旧值仅安全版本可视为 0，损坏或溢出失败关闭。

集合（默认客户端禁止读写）：

- `wecom_bindings/<userId>`：`userId, memberId, memberKey, version, status, configVersion, securityEpoch, currentChallengeId, verifiedAt, updatedAt`；解绑保留版本墓碑、清空 memberId，不重置为 0。
- `wecom_identity_reservations/<sha256(corpId + canonicalMember)>`：`userId, bindingVersion`；摘要输入用长度明确的 JSON 数组编码，避免字符串拼接碰撞。
- `wecom_binding_challenges/<challengeId>`：`userId, memberKey, bindingVersion, configVersion, credentialVersion, securityEpoch, codeHash, attempts, expiresAt, consumedAt, sendState`；无明文码。每用户只认绑定中的 currentChallengeId。
- `wecom_send_receipts/<challengeId>`：`requestId, bodyDigest, state, leaseExpiresAt, resultCode, updatedAt`；以挑战为去重主键，不允许换 requestId 再发同一码。
- `system_settings/wecom_rate_<scope>_<digest>`：scope 为 account/member/initiator；`sentAtMs` 最多保留最近一小时 5 项，跨改绑不删除。另设 admin-bind 限流保护恶意反复建绑，默认 20 次/小时。
- `users.wecomSecurityEpoch`：非负安全整数；缺失旧值 0。只在安全状态变化递增，非普通登录/改昵称。
- `audit_logs`：独立随机审计 ID，允许内部 userId、操作、版本、时间及结果枚举；无成员值、码、载荷或供应商原文。

统一公开投影 `BindingView`：`{status, revision, accountLabel, maskedMemberId, canSend, canConfirm, businessEnabled:false, challenge:null|{id,expiresAt,resendAt,state}}`。accountLabel 为当前已授权目标小程序账号的安全显示名，供管理员确认目标，不能由query替代。status 为 `unbound|pending|verified|paused|reconfirm_required`；不返回摘要、企微原成员值、数据库定位信息或密钥。已验证文案必须是“身份已验证，业务提醒待启用”。

统一安全错误码：`WECOM_DISABLED`、`WECOM_CONFIG_INVALID`、`WECOM_MEMBER_INVALID`、`WECOM_MEMBER_IN_USE`、`WECOM_STATE_INVALID`、`WECOM_VERSION_CONFLICT`、`WECOM_CODE_INVALID`、`WECOM_CODE_EXPIRED`、`WECOM_CODE_EXHAUSTED`、`WECOM_RATE_LIMITED`、`WECOM_SEND_REJECTED`；既有鉴权错误沿用。网络不确定是公开结果 `unknown`，不把含原始网络对象的异常透传。

工厂签名及返回方法（参数均为对象，repo 方法均 Promise）：

```js
createWecomStore({ db, clock, idFactory })
// => { atomic(apply), read(collection, id) }
// atomic 的 tx => { read(collection,id), set(collection,id,data),
//                  update(collection,id,changes), remove(collection,id) }
// 本层只包装固定 doc；区分 missing document 与集合/权限/网络失败。

createWecomBindingRepository({ store, config })
// => { get({actorId,targetUserId}), bind({actorId,userId,memberId,expectedRevision}),
//      unbind({actorId,userId,expectedRevision}), pause({actorId,expectedRevision}) }

createWecomChallengeRepository({ store, config, codeFactory })
// => { issue({actorId,expectedRevision}),
//      confirm({actorId,challengeId,code,consent,expectedRevision}) }
// issue => { view:BindingView, envelope:{challengeId,code,configVersion} }
// envelope 仅供当前服务器调用链，不返回小程序。
// confirm => { view } 或 { errorCode }；错误计次先提交，再由 service 抛安全错误。

createWecomDeliveryRepository({ store, config })
// => { claim({requestId,bodyDigest,envelope}),
//      finish({challengeId,requestId,outcome}) }
// claim => {kind:'claimed',memberId} | {kind:'existing',outcome}
// outcome => {state:'accepted'|'rejected'|'unknown',code:安全枚举}

createWecomService({ bindings, challenges, sender })
// => { getMyBinding({actor}), getUserBinding({actor,userId}),
//      bindUser({actor,userId,memberId,expectedRevision}),
//      unbindUser({actor,userId,expectedRevision}), pauseMyBinding({actor,expectedRevision}),
//      sendMyCode({actor,expectedRevision}),
//      confirmMyCode({actor,challengeId,code,consent,expectedRevision}) }
// 所有方法返回 BindingView，sendMyCode 额外返回 deliveryState。
```

### Task 1：纯状态、密码学和默认关闭配置

**Files:** 新建 businessApi `lib/wecom-domain.js`、`lib/wecom-config.js`、`lib/wecom-member-contract.js`、`test/wecom-domain.test.js`、`test/wecom-config.test.js`。

**Interfaces:** 产出 `generateCode():string`、`hashCode({key,challengeId,code}):string`、`nextSecurityEpoch(value):number`、`securityEpochAfterUserChange(user,changes):number`、`securityEpochAfterCredentialChange(user,current,next):number`、`limitWindow({sentAtMs,now,minGapMs,maxCount,windowMs}):{allowed,retryAt,sentAtMs}`、`readWecomConfig(env,{memberContract}):config`、`normalizeMember(value,memberContract):{memberId,canonical}`、`projectBinding({binding,user,credential,challenge,config,now}):BindingView`、`wecomError(code):WecomError`、`isWecomError(error):boolean`。WecomError 为本模块私有类，仅本模块产生；纯规则不引入现有模板仓储或云SDK，任务8编排边界为此类型补现有应用错误标记。

- [ ] 写先失败测试；所有示例以 `node:test` 和 `node:assert/strict` 引入，测试账号只用 `test-*`。最小核心断言：

```js
assert.match(generateCode(), /^\d{6}$/);
assert.notEqual(hashCode({key:Buffer.alloc(32,1),challengeId:'a',code:'000123'}),
                hashCode({key:Buffer.alloc(32,1),challengeId:'b',code:'000123'}));
assert.equal(readWecomConfig({}, {memberContract:null}).verificationEnabled, false);
assert.throws(() => nextSecurityEpoch(Number.MAX_SAFE_INTEGER));
assert.equal(limitWindow({sentAtMs:[1000,61000,121000,181000,241000],
  now:300000,minGapMs:60000,maxCount:5,windowMs:3600000}).allowed, false);
```

- [ ] 执行 `node --test cloudfunctions/businessApi/test/wecom-domain.test.js cloudfunctions/businessApi/test/wecom-config.test.js`，确认缺少实现而失败。
- [ ] 实现随机码 `crypto.randomInt(0,1000000).toString().padStart(6,'0')`，HMAC 域分隔 `JSON.stringify(['wecom-code-v1',challengeId,code])`，摘要等长后 timingSafeEqual；拒绝数组、继承值、访问器、未知字段及非整数时间。成员禁止空白、`@all`、`|`、控制字符；长度/字符集/大小写规范化由经核对的 memberContract 明确提供，不在未核对时放行真实绑定。
- [ ] 安全版本规则代码固定为：用户从 active 变为非 active、清除已有 openid，或凭据 `hash/salt/algorithm/keyLength` 任一真正改变时递增；纯 failedAttempts、lastAuthenticatedAt、lockedUntil 变化不递增。客户端不能写此字段。旧投影非空 `wecomUserId` 永远不证明 verified。
- [ ] 配置仅服务端：`WECOM_BINDING_ENABLED`、`WECOM_VERIFICATION_ENABLED` 默认 false；`WECOM_BUSINESS_REMINDERS_ENABLED` 必须 false；发送开启要求企业、Agent、配置版本、独立高熵签名密钥/验证码密钥、固定 HTTPS sender URL 和官方成员契约。两种密钥不能相同。缺配置返回关闭/安全错误，不破坏 businessApi 其他方法装配。memberContract 接口为 `{verified:boolean,normalize(value):{memberId,canonical}}`；初始官方契约模块导出 `Object.freeze({verified:false})`，默认开启请求因此拒绝；只有测试注入已定义的合成契约，任务7核对官方后才写入真实normalize规则。
- [ ] 重跑两项测试；增加前导 0、59/60 秒边界、滚动一小时边界、损坏计数/时间、错误配置、原始标识不进入公开投影测试。通过后仅提交该任务五个文件，提交信息 `feat: define fail-closed WeCom verification rules`。

### Task 2：固定文档绑定事务与唯一占位

**Files:** 新建 businessApi `lib/wecom-store.js`、`lib/wecom-binding-repository.js`、`test/wecom-binding-repository.test.js`；复用 `test/helpers/fake-cloud-database.js`，不更换其事务冲突模型。

**Interfaces:** 消费任务 1 规则，产出上述 store/bindings 接口。get 自己可读、他人只有当前活动超级管理员可读；bind/unbind 只有当前活动超级管理员；pause 只能本人。

- [ ] 写失败测试，完整合成 seed 包含活动 super_admin `test-admin`、活动用户 `test-a/test-b`、凭据 `credentialVersion:0,mustChangePassword:false` 和现有管理员 guard。对同一成员执行：

```js
const results = await Promise.allSettled([
  bindings.bind({actorId:'test-admin',userId:'test-a',memberId:'test-member',expectedRevision:0}),
  bindings.bind({actorId:'test-admin',userId:'test-b',memberId:'test-member',expectedRevision:0})
]);
assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
assert.deepEqual(fake.transactionQueries, []);
assert.ok(fake.transactionRuns.every(x => x.operations <= 100));
assert.equal(fake.documents('wecom_identity_reservations').length, 1);
```

- [ ] 运行 `node --test cloudfunctions/businessApi/test/wecom-binding-repository.test.js` 得到预期失败。
- [ ] 在事务中固定读取操作者、目标、凭据、原绑定和新旧占位，再校验权限/版本；提交时更新旧占位、新占位、绑定及脱敏审计。首次创建 revision=1，改绑/暂停/解绑单调 +1；占位损坏不得“自动修复”或抢占。同成员不必要重复保存用版本冲突/现状结果，不清除别人占位。
- [ ] 暂停不释放成员占位；解绑释放自己的占位并留下版本墓碑；改绑释放旧成员并令原挑战不再 current。每次递增绑定版本，必须在同一事务把保留占位的 bindingVersion 同步为新版本。更新 `users.wecomUserId` 仅兼容投影，不改变业务权限。建绑不调用 sender。代码事务形状：

```js
return store.atomic(async tx => {
  const actor = await tx.read('users', actorId);
  const target = await tx.read('users', userId);
  // 以下校验与写入均在同一个回调中：当前超级管理员、目标活动状态、
  // expectedRevision、原/新占位归属；不得在回调中调用任何网络发送。
  return commitBindingInTransaction({tx,actor,target,input,config});
});
```

`commitBindingInTransaction` 是本任务仓储内私有函数，输入 input 即 bind 参数；输出公开 BindingView，不导出也不由其他任务调用。
- [ ] 补并发改绑/解绑、撤管理员权限、目标已停用、损坏占位、失败写回滚、墓碑防 ABA、memberContract 大小写规范化唯一性及建绑限流测试。重跑通过，显式提交本任务三个新文件，信息 `feat: reserve verified WeCom identities transactionally`。

### Task 3：账号安全变更使绑定失效，正常登录不失效

**Files:** 修改 businessApi `lib/cloud-account-repository.js`、`test/helpers/auth-harness.js`、`test/helpers/admin-user-harness.js`；新增 `test/wecom-account-invalidation.test.js`；扩充 `test/cloud-account-repository.test.js`。

**Interfaces:** 不改公开账号服务方法。使用任务 1 的两个 securityEpochAfter 方法，在用户/凭据既有事务内更新 `users.wecomSecurityEpoch`。binding 与 challenge 读出时比较 epoch，保证 O(1) 失效，不扫描挑战集合。

- [ ] 写失败测试：先用真实仓储 seed 用户 epoch=4，调用 `repository.updateCredential('test-a',{lastAuthenticatedAt:new Date(1000)})` 后断言 epoch=4；改变 password hash 后断言 epoch=5。其他断言：

```js
assert.equal(securityEpochAfterUserChange({status:'active',wecomSecurityEpoch:4},
  {status:'disabled'}), 5);
assert.equal(securityEpochAfterUserChange({status:'disabled',wecomSecurityEpoch:5},
  {status:'active'}), 5);
assert.equal(securityEpochAfterCredentialChange({wecomSecurityEpoch:4},
  {hash:'test-hash',salt:'test-salt'}, {hash:'test-hash',salt:'test-salt',failedAttempts:0}), 4);
```

- [ ] 运行 `node --test cloudfunctions/businessApi/test/wecom-account-invalidation.test.js`，确认失败。
- [ ] 在 `updateUserAndAdminGuard` 和 `updateCredential` 的事务内写安全版本，不能调用事务外 hook。凭据多次更新只在实际密码字段变化时递增；密码重置、本人改密、恢复管理员和清除微信绑定路径全部经过同一边界。不改变管理员计数、credentialVersion/challengeEpoch 的旧规则。
- [ ] 模拟仓储同步此行为；fixture 缺省 epoch=0，损坏值失败关闭。challenge 比较 credentialVersion 和 securityEpoch；已 verified binding 只比较 securityEpoch/configVersion/成员占位及活动状态，不比较每次登录都变的 credentialVersion。
- [ ] 运行新增测试及 `node --test cloudfunctions/businessApi/test/cloud-account-repository.test.js cloudfunctions/businessApi/test/auth-service.test.js cloudfunctions/businessApi/test/admin-user-service.test.js`；测试停用→启用后 reconfirm_required、解除微信绑定、改昵称不失效、真实事务回滚、100 次操作上限。通过后显式提交本任务五个文件，信息 `fix: invalidate WeCom consent on account security changes`。

### Task 4：挑战签发、滚动限流与本人确认

**Files:** 新建 businessApi `lib/wecom-challenge-repository.js`、`test/wecom-challenge-repository.test.js`。

**Interfaces:** 消费 store/config/domain，产出 issue/confirm。`codeFactory` 生产为 generateCode，测试注入 `() => '000123'`；随机 challengeId 在事务重试回调之外产生，整个回调重试不重复网络副作用。

- [ ] 写失败测试，seed 一个当前待确认绑定；`issue` 后用错误码确认，检查尝试次数真的落盘，再用正确码：

```js
const issued = await challenges.issue({actorId:'test-a',expectedRevision:1});
const bad = await challenges.confirm({actorId:'test-a',challengeId:issued.view.challenge.id,
  code:'999999',consent:true,expectedRevision:issued.view.revision});
assert.equal(bad.errorCode, 'WECOM_CODE_INVALID');
assert.equal(fake.documents('wecom_binding_challenges')[0].attempts, 1);
assert.equal(JSON.stringify(fake.documents('wecom_binding_challenges')).includes('000123'), false);
```

- [ ] 运行 `node --test cloudfunctions/businessApi/test/wecom-challenge-repository.test.js` 得到失败。
- [ ] issue 事务读取当前账号、凭据、绑定/占位、账号/member/initiator 三个限流文档；使用服务端 now、滚动一小时数组及60秒间隔。成功签发原子更新绑定及占位版本、currentChallengeId、当前 securityEpoch/configVersion、挑战摘要和三份限流记录；发起方只能本人，member 限流跨解绑保留。暂停后主动重新发送进入 pending，不能直接恢复 verified。新挑战 sendState=issued。
- [ ] confirm 事务重新校验归属、consent===true、版本/epoch/config/占位、次数与5分钟期限；错误码先提交 `{errorCode}` 后由 service 抛错，不能回滚错误计数。成功 consumedAt + verifiedAt 一次性落盘，绑定/占位版本同步递增；同挑战第二次确认拒绝，不恢复旧绑定。尚未发送/明确拒绝的码不能确认；accepted 或 unknown 的有效挑战可以确认。
- [ ] 补5次耗尽、并发猜码、重发旧码、整点前后滚动限制、改绑绕限流、凭据更新、停用、exact expiry、对象非法原型、客户端伪造 verified 测试，重跑通过。显式提交两文件，信息 `feat: add one-time WeCom ownership challenges`。

### Task 5：服务器签名协议与固定发送地址客户端

**Files:** 新建 businessApi `lib/wecom-request-auth.js`、`lib/wecom-sender-client.js`、`test/wecom-request-auth.test.js`、`test/wecom-sender-client.test.js`。

**Interfaces:** `signRequest({key,keyId,requestId,issuedAt,body}) => {body:Buffer,headers}`；`verifyRequest({keys,headers,body,now}) => {requestId,bodyDigest,envelope}`；`createWecomSenderClient({config,transport,clock,idFactory}).send(envelope) => outcome`。transport 是注入的 `({url,method,headers,body,timeoutMs,maxResponseBytes}) => Promise<{statusCode,body:Buffer}>`，生产仅使用 HTTPS。

- [ ] 写签名篡改和错误配置失败测试：

```js
const signed = signRequest({key:Buffer.alloc(32,1),keyId:'test-key',requestId:'a'.repeat(32),
  issuedAt:1000,body:{challengeId:'test-challenge',code:'000123',configVersion:1}});
assert.throws(() => verifyRequest({keys:{'test-key':Buffer.alloc(32,1)},
  headers:signed.headers,body:Buffer.from('{}'),now:1000}));
assert.throws(() => verifyRequest({keys:{'test-key':Buffer.alloc(32,1)},
  headers:signed.headers,body:signed.body,now:62001}));
```

- [ ] 执行 `node --test cloudfunctions/businessApi/test/wecom-request-auth.test.js cloudfunctions/businessApi/test/wecom-sender-client.test.js` 得到预期失败。
- [ ] 固定方法 `POST /internal/wecom/verification`；HMAC 输入 `JSON.stringify(['wecom-request-v1','POST',path,keyId,requestId,issuedAt,sha256(rawBody)])`。时间偏差≤60秒；body≤4096字节；拒绝重复鉴权头、未知用途/字段、query、非 JSON、无签名请求。密钥选择只能已配置 keyId，常量时间校验，签名通过前不查数据库。
- [ ] client 每次 issue 只调用一次；请求超时10秒、响应≤16KiB、不跟随3xx、只接受固定 config URL，不接收客户端 URL/企业/Agent/收件人。HTTPS传输异常返回 `{state:'unknown',code:'TRANSPORT_UNKNOWN'}`，不返回原始错误；明确关闭在签发之前报 WECOM_DISABLED。
- [ ] 重跑并补字节级 body 篡改、过大请求、未知 key、同 envelope 不同签名时间、响应无效JSON/HTTP200业务拒绝、恶意重定向、日志脱敏测试。显式提交四文件，信息 `feat: authenticate bounded WeCom verification requests`。

### Task 6：云托管验证处理器与持久去重

**Files:** 新建 businessApi `lib/wecom-delivery-repository.js`、`test/wecom-delivery-repository.test.js`；新建 cloudrun/wecom-notifier `lib/handler.js`、`test/handler.test.js`、`package.json`、`.gitignore`；新建 `tools/build-wecom-notifier.mjs`。

**Interfaces:** 消费任务5 verifyRequest、任务4挑战和任务2store；产出 `createHandler({config,deliveries,provider,clock}).handle({method,path,headers,body}) => {statusCode,body}`；provider 为 `sendVerification({memberId,code}) => outcome`，禁止外部直接传入 memberId。

- [ ] 使用假传输 Promise barrier 模拟并发相同请求，断言只发送一次；预先将 receipt 置 claimed 并推进超时，断言结果 unknown 不重新发送：

```js
let sends = 0;
const provider = {sendVerification: async () => {
  sends += 1; return {state:'accepted',code:'PROVIDER_ACCEPTED'};
}};
const handler = createHandler({config,deliveries,provider,clock:() => 1000});
await Promise.all([handler.handle(request), handler.handle(request)]);
assert.equal(sends, 1);
```

本测试的 config 为任务1测试配置；deliveries 使用 createWecomDeliveryRepository 与 fake DB；request 由任务5 signRequest 生成，不使用真实网络。
- [ ] 运行 `node --test cloudfunctions/businessApi/test/wecom-delivery-repository.test.js cloudrun/wecom-notifier/test/handler.test.js`，确认失败。
- [ ] claim 事务固定读账号、凭据、当前绑定/占位、challenge、receipt；再次比较 codeHash、配置、期限和版本，并要求账号active、mustChangePassword=false、未在lockedUntil内；租约30秒。receipt 主键 challengeId，已领取/已终结都不再领取，已领取重复请求返回 unknown。领取时同时将当前挑战 sendState=unknown，保证外部已接受但进程崩溃时已收到的有效码仍可确认。调用 provider 不在事务里；完成后 finish 只更新当前 requestId 的 receipt，以及仍匹配当前绑定版本的 challenge.sendState，不修改绑定授权。供应商调用前执行上述领取校验；承认领取后与外部已发之间存在不可撤回窗口。
- [ ] build 脚本只复制 `wecom-domain.js`、`wecom-config.js`、`wecom-member-contract.js`、`wecom-store.js`、`wecom-request-auth.js`、`wecom-delivery-repository.js` 六个共享源，无其他业务依赖。产物目录 `cloudrun/wecom-notifier/.generated/` 在本目录.gitignore中排除，构建manifest为各文件SHA256；测试构建两次hash相同、源改动能检出、没有密钥文件。不能手工维护两份协议。package.json 配置 `"private":true`、`"scripts":{"test":"node --test test/*.test.js","start":"node server.js"}`；此任务不安装SDK。
- [ ] 补更换 requestId 重放、过期租约、崩溃后重复、解绑与成功结果竞态、hash错误、数据库权限失败、100操作预算测试。重跑通过并显式提交上述七个文件，信息 `feat: deduplicate WeCom verification delivery`。

### Task 7：真实供应商与数据库适配器、关闭态容器

**Files:** 新建 cloudrun/wecom-notifier `lib/wecom-client.js`、`lib/database.js`、`server.js`、`test/wecom-client.test.js`、`test/database.test.js`、`test/server.test.js`、`Dockerfile`、`.dockerignore`、`package-lock.json`；更新 package.json、businessApi `lib/wecom-member-contract.js` 及 `test/wecom-domain.test.js` 的官方边界用例；新建 `docs/deployment/wecom-verification.md`。

**Interfaces:** `createWecomClient({config,transport,clock}).sendVerification({memberId,code})`；`createDatabase({sdk,config,credentialProvider}) => db`（返回符合 store fixed-doc 接口的 facade）；`createServer({handler}) => http.Server`。程序导入不得自动监听或发网络，只有主入口启动。

- [ ] 先核对并记录官方契约：单成员UserID规范、获取令牌有效期、文本消息字段/业务返回码/无效成员、微信插件支持格式；核对普通容器的 Node 运行时、传统文档库事务SDK形状与鉴权。将来源日期和精确校验/规范化规则写入 member-contract 的注释及测试，通过后 verified 才为true；来源不得是客户端字段/运行时随意环境开关。若官方正文仍不可读取，本任务真实适配器保持未完成，仅运行契约假对象测试，不安装猜测依赖、不启动生产。允许用户提供官方页面正文；禁止用同名/手机号推断UserID。
- [ ] 官方核对通过后，用下列命令解析并锁定实际兼容版本，不预填未经核验的版本。若主版本不是3、最低Node要求或事务API不兼容，则记录阻断而不直接安装。运行时镜像通过 `docker pull node:lts-bookworm-slim` 与 `docker image inspect node:lts-bookworm-slim` 得到实际 RepoDigest，检查符合 SDK engines 后作为强制构建参数 RUNTIME_IMAGE。旧云函数运行时不变。

```powershell
$wecomSdkMetadata = npm.cmd view @cloudbase/js-sdk version engines --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $wecomSdkMetadata.version -notmatch '^3\.\d+\.\d+$') { throw 'SDK contract review required' }
$wecomSdkVersion = $wecomSdkMetadata.version
npm.cmd install --save-exact --prefix cloudrun/wecom-notifier "@cloudbase/js-sdk@$wecomSdkVersion"
```
- [ ] 写供应商测试，令 transport 返回官方确认的“HTTP200但成员无效”响应及超时；断言 rejected/unknown，不是 accepted。本地Server测试：

```js
const server = createServer({handler:{handle:async () => ({statusCode:401,body:{code:'UNAUTHORIZED'}})}});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// 使用 node:http 对实际监听端口发无签名 POST；断言401及无正文/头日志。
await new Promise(resolve => server.close(resolve));
```

- [ ] 执行 `node --test cloudrun/wecom-notifier/test/wecom-client.test.js cloudrun/wecom-notifier/test/database.test.js cloudrun/wecom-notifier/test/server.test.js`，确认缺实现失败。
- [ ] provider 只访问官方HTTPS主机、禁3xx、每次请求超时5秒/响应≤64KiB；令牌缓存按官方 expires_in 提前60秒失效、同实例并发刷新单飞。最多在官方明确“令牌失效且消息未被接受”返回时刷新重试一次；未知返回/网络超时不重试。文本仅验证码、5分钟期限和防转发提示，不含客户/订单或小程序账号名。不以HTTP状态冒充业务成功，不持久化token。
- [ ] database facade 对 get/set/update/remove 的SDK差异逐项测试；复用 fixed-doc transaction retry，SDK错误不吞。优先最小权限运行身份/临时凭据，普通容器不得伪造函数 context 或借匿名key绕过安全规则。权限不可实现时报告部署阻断，不索取主账号永久密钥兜底。
- [ ] Server只提供无敏感信息 `/healthz` 和固定内部POST；连接/请求大小有界，关闭态发503且无provider调用。Docker非root，排除 `.env*`、tests、logs、outputs、源码仓库和凭据；共享源仅经过build manifest进入镜像。补token单飞、过大返回、证书失败、泄密异常、默认关闭、DB写失败测试，重跑通过再显式提交本任务路径，信息 `feat: add gated WeCom notifier runtime`。官方/SDK门禁未通过时不提交假定可运行的容器为已完成。

### Task 8：businessApi 编排及受保护路由

**Files:** 新建 businessApi `lib/wecom-service.js`、`test/wecom-service.test.js`、`test/wecom-routes.test.js`；修改 `index.js`。

**Interfaces:** 上述 createWecomService 七方法；路由名固定 `getMyWecomBinding/getUserWecomBinding/bindUserWecom/unbindUserWecom/pauseMyWecomBinding/sendMyWecomCode/confirmMyWecomCode`，顺序映射 `getMyBinding/getUserBinding/bindUser/unbindUser/pauseMyBinding/sendMyCode/confirmMyCode`。

- [ ] 写路由测试复用 `test/account-routes.test.js` 的 createBusinessApi 注入方法，覆盖未登录、停用、普通人操作他人、payload覆盖actor。关键编排：

```js
const result = await service.sendMyCode({actor:{_id:'test-a'},expectedRevision:1});
assert.equal(Object.hasOwn(result,'envelope'), false);
assert.equal(Object.hasOwn(result,'code'), false);
assert.equal(result.deliveryState, 'unknown');
// sender 桩抛超时；验证持久挑战可供员工收到码后继续确认。
```

- [ ] 运行 `node --test cloudfunctions/businessApi/test/wecom-service.test.js cloudfunctions/businessApi/test/wecom-routes.test.js`，确认失败。
- [ ] createBusinessApi 增加可选 wecomService 和单独 route factory；所有动作进入 protected domainRoutes，不进入 PUBLIC_ACTIONS/legacyRoutes。payload严格白名单；self方法不接受userId，actor只取 resolveActor，仓储事务再查其权限。service仅在 `isWecomError(error)` 为真时补 `APPLICATION_ERROR_MARKER`（从现有 cloud-template-repository 导入）；原始数据库/供应商异常不能仅凭同名code获得此标记。safe error加入日志枚举，未知错误仍INTERNAL_ERROR。
- [ ] service 按 `issue → sender.send → 查询当前BindingView` 执行，传入code只存在局部变量；挑战计次errorCode在事务提交后转应用错误。若用户重发/解绑后旧响应到达，返回当前状态，不写回旧版本。绑定、确认、暂停使用精确expectedRevision，冲突要求刷新，不自动重提。
- [ ] 默认配置关闭不妨碍业务接口与登录；get 返回清晰不可用状态，非法写/发送明确拒绝。补sender失败仍保留当前挑战、配置关闭无issue、日志无code、旧wecomUserId不升级授权测试。重跑通过，显式提交四文件，信息 `feat: expose guarded WeCom binding actions`。

### Task 9：管理员绑定页面

**Files:** 新建 `miniprogram/services/wecom.js`、`utils/wecom-page-state.js`、`pages/admin-user-wecom/index.{js,json,wxml,wxss}`、`test/wecom-admin-flow.test.js`；修改 `pages/admin-users/index.{js,wxml}`、`app.json`。

**Interfaces:** 客户端services导出上述七个路由同名方法，精确payload，均调用 callBusinessApi(...,{silent:true})。`createWecomPageState({getUserId}) => {begin(),isCurrent(ticket),invalidate()}`；ticket捕捉账号ID及递增序号，页面hide/unload使失效，不以memberId作会话身份。

- [ ] 写失败测试，复用 admin-users-flow 的 loadPage/模块替身模式；服务的改绑入参只有 `{userId,memberId,expectedRevision}`，取消确认框不调用；保存不调用sendMyWecomCode：

```js
const state = createWecomPageState({getUserId:() => currentUserId});
currentUserId = 'test-a'; const ticket = state.begin();
currentUserId = 'test-b'; assert.equal(state.isCurrent(ticket), false);
state.invalidate(); assert.equal(state.isCurrent(ticket), false);
```

- [ ] 运行 `node --test miniprogram/test/wecom-admin-flow.test.js`，确认失败。
- [ ] 用户行加“企微提醒”按钮，只传内部账号ID导航。页面先服务器读目标与绑定，只读身份信息不从query信任角色。UserID输入写明“不是姓名/手机号/OpenID”；预览已有小程序账号与完整输入，再明确确认改绑/解绑失效后果。界面不自动读剪贴板、不留本地缓存、不自动发送、不提供管理员确认码入口。
- [ ] 每个请求开始保存ticket，await后同时检查ticket与活动管理员角色再setData；hide/unload清空输入并失效，返回时重新读取。失败保持草稿但不能误报保存成功；版本冲突刷新后让用户重新确认。
- [ ] 增加新页 app.json 注册，样式复用现有卡片、按钮；补普通用户重定向、迟到响应、双击单飞、权限撤销、配置关闭和取消操作测试，运行新增及 `node --test miniprogram/test/admin-users-flow.test.js miniprogram/test/app-config.test.js`。通过后显式提交该任务文件，信息 `feat: add administrator WeCom binding UI`。

### Task 10：员工本人确认与暂停页面

**Files:** 新建 `miniprogram/pages/wecom-reminders/index.{js,json,wxml,wxss}`、`test/wecom-self-flow.test.js`；修改 `pages/profile/index.{js,wxml}`、`app.json`；消费任务9服务与request guard。

**Interfaces:** 页面onShow调用getMyWecomBinding；按钮触发sendMyWecomCode、confirmMyWecomCode、pauseMyWecomBinding。验证码仅输入框当前状态短期存在，不写 storage/globalData/query，hide/unload/完成/失败后清空。

- [ ] 写失败测试，模拟旧请求在换账号后返回，断言不出现原挑战；确认前必须显式勾选同意，输入保留前导0。发送网络未知不能显示“发送成功”，正确结果文案测试：

```js
assert.equal(view.businessEnabled, false);
assert.equal(renderedStatus, '身份已验证，业务提醒待启用');
assert.equal(sendResultMessage('unknown'), '发送结果待确认');
```

`sendResultMessage(state)` 是页面内部三态文案方法：accepted→“验证消息已提交，请查收”，rejected→“发送未成功，请检查接收配置”，unknown→上述固定文案；测试通过页面实际setData读取，不新建额外渲染器。
- [ ] 运行 `node --test miniprogram/test/wecom-self-flow.test.js`，确认失败。
- [ ] 在个人资料加“微信提醒”链接独立页，避免重构头像/昵称流程；展示maskedMemberId和五状态。发送前提示接收位置、5分钟有效及不转发；重发先提醒旧码失效，等待60秒提示由服务器resendAt派生，仅作UI限制，不能代替后端限流。输码 `<input type="number" maxlength="6" password="true" ...>`，提交按字符串校验，不Number()转换；异步按钮busy防重复，取消/失败可恢复。
- [ ] 暂停后显示需重新确认；不提供“自动永久订阅”承诺。hide清空验证码、失效请求并停倒计时；重新show重新读，接口失败不沿用旧canSend/canConfirm。文案错误只映射安全枚举，不展示原始网络异常。
- [ ] 补Mac返回页、切账号、自动登录恢复、卸载定时器、000123、同意未勾选、超时后有效码确认、锁定/失效码、已验证不等于业务发送测试；运行新增及既有 `node --test miniprogram/test/account-flow.test.js`。通过后显式提交任务文件，信息 `feat: add employee WeCom receipt confirmation UI`。

### Task 11：端到端模拟、全回归与部署手册

**Files:** 新建 businessApi `test/wecom-verification-integration.test.js`、`test/wecom-shared-contract.test.js`；完善 `docs/deployment/wecom-verification.md`；更新 PROJECT/STATUS，新增 `docs/memory/decisions/ADR-0022-wecom-verified-binding.md`（先检查编号未被其他工作占用）。

**Interfaces:** 全链路用真实 service/repos/签名/handler + fake DB + provider桩，不调用线上。共享协议测试直接加载构建后的实际文件，不能只比文件名。

- [ ] 写先失败场景：管理员绑定→本人发码→签名校验→provider accepted→本人确认→暂停；另一个场景provider记录已接受后抛超时→unknown→已收到码仍确认成功。最低断言：

```js
assert.equal(fake.documents('notifications').length, 0);
assert.equal(fake.documents('business_lines').length, 0);
assert.equal(providerCalls.length, 1);
assert.equal(finalView.status, 'verified');
assert.equal(finalView.businessEnabled, false);
assert.ok(fake.transactionRuns.every(run => run.operations <= 100));
```

- [ ] 执行 `node --test cloudfunctions/businessApi/test/wecom-verification-integration.test.js cloudfunctions/businessApi/test/wecom-shared-contract.test.js`；跨模块缺口先观察失败，再只修对应模块，不用跳过或放松断言消除失败。
- [ ] 完整模拟矩阵包括账号停用/重置/解绑竞态、错误计次持久性、签名重放、旧部署协议不兼容、令牌刷新并发、DB断开失败关闭及日志敏感值扫描。fixture验证码/密钥/成员特征仅测试内存，捕获日志/返回/持久记录，确保无明文（绑定集合允许必要memberId但日志/公开视图不允许）。
- [ ] 手册明确新增四集合及限流system_settings文档，只使用_id点查，无伪造“必需组合索引”；权限仅服务端，已有权限规则不扩大。过期challenge/receipt本期不添加Timer/TTL删除；行数随人工验证增长，不含明文码，后续保留清理必须单独批准。去重记录不得删除后重发旧challenge；挑战current及过期校验仍强制。
- [ ] 执行下列每条并记录独立exit code，不把最后一条成功代表整批成功：

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node --test miniprogram/test/*.test.js
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudrun/wecom-notifier
node tools/test-wxml-structure.mjs
node tools/build-wecom-notifier.mjs --check
git diff --check
python "C:/Users/87579/.codex/skills/maintaining-project-memory/scripts/validate_memory.py" .
```

- [ ] 无真实配置的测试默认不得有互联网连接；容器依赖安装/镜像构建与实际cloud验收分开记录。WXML脚本若未覆盖新页，扩充 `tools/test-wxml-structure.mjs` 的页面集合及新页面事件绑定断言，再运行到通过。
- [ ] 整体代码复核后记录精确通过数量、失败/未验证项，复查敏感信息和精确diff；更新稳定架构与ADR，但不能把门禁未过部分写为上线。逐文件暂存本任务测试、手册、记忆、实际需要的WXML脚本；本地提交 `test: verify WeCom binding end to end`，没有用户请求不推GitHub。

### Task 12：单独授权后的线上单人验收（不随本计划自动执行）

**Files:** 仅补 `docs/deployment/wecom-verification.md`、`docs/memory/STATUS.md` 的脱敏结果；线上动作先取得精确范围授权。

**Interfaces:** 输入为任务1–11通过的不可变代码版本、合规域名/HTTPS及官方契约；输出为指定一人双端可观察结果，非全员功能发布。

- [ ] 展示确定的CloudRun规格、费用影响、镜像/运行身份最小权限、域名与HTTPS配置、所需数据库权限和实际接收对象，取得上线授权。未备案通过、不满足企微可信域名/回调要求、出口不符或任一契约未核验则停在对应阻断，不绕过。
- [ ] 先关闭验证发送开关部署容器，健康检查不含Secret、token或成员；从实际运行容器核验固定出口，不把云函数公网IP套用。业务发送开关始终false，workflowReminder及其他Timer保持原样。
- [ ] 生产Secret通过受控云端配置注入，不进本机Git/页面截图；如果需要企微接收回调，先另行实现官方签名/解密验证，再配置。这个回调工作不包含在已实现的发送POST内，不能临时开放匿名代理替代。
- [ ] 最小集合/权限就绪，发布精确businessApi、上传新版小程序为开发/体验版本；未经授权不提交审核或正式发布。回读云函数代码hash及配置，原权限/环境变量/Timer保持不变（仅新增经批准的本功能配置）。
- [ ] 仅对指定本人启用验证入口，管理员建绑不发消息；本人点击发送，确认企微和普通微信均看到同一码，再本人提交。记录可观察收件及状态，不保存码/截图/个人UserID；不替本人同意。
- [ ] 本人暂停、改绑/停用的验证用单独合成或明确批准账号；不得为验收停用在岗同事。核对新的发送被阻止及业务仍正常；测试结束按用户决定关闭验证开关或保留指定范围，业务催办仍关闭。
- [ ] 若出错，先关闭验证开关阻断新发送；保留去重/版本记录，回滚小程序入口和匹配服务版本，不删除已发送记录、不复活旧挑战。报告不可撤回的已接受消息，小时提醒进入后续设计而不是自动开启。

## 计划自查与交接

覆盖：设计§4→任务2/8/9/10；§5→任务1/2/3/4/6；§6→任务5/6/7/12；§7→任务11/12。Review Focus五类均有对应失败测试。验证码未落盘、错误尝试事务提交、跨账号迟到响应、同challenge去重、正常登录不撤收件授权是独立复核重点。

执行方式供用户选择：推荐按任务逐项实施并逐项独立复核，因为身份对应与外部消息发送一旦出错会影响真实员工；也可以当前会话由同一实现者按序完成，末尾再独立整体复核。两者均先做本地模拟，不隐含生产发布、购买、发消息或开启定时器的授权。计划批准及执行方式选择之前，不进入产品代码实现。
