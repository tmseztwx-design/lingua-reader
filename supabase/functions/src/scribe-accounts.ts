// Password hashing/verification is handled by Supabase Auth, never in the browser or our tables.
// Application sessions are separate, short-lived, hashed, revocable capabilities.
import {database,json,randomKey,hashKey,libraryFor,readJsonLimited,allRows} from "../_shared/cloud.ts";

type Account=Record<string,any>;
const summary=(a:Account)=>({id:a.id,username:a.username,displayName:a.display_name,role:a.role,disabled:a.disabled,libraryId:a.library_id,createdAt:a.created_at,lastLoginAt:a.last_login_at});
const fail=(message:string,status=400)=>Object.assign(new Error(message),{status});
const validName=(name:string)=>/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(name);
function safeEqual(a:string,b:string){const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);let diff=x.length^y.length;for(let i=0;i<Math.max(x.length,y.length);i++)diff|=(x[i]||0)^(y[i]||0);return diff===0;}
function passwordFor(body:Account){
  const password=body.password===undefined||body.password===''?'Sc9!'+randomKey().slice(0,22):String(body.password);
  if(password.length<12||new TextEncoder().encode(password).length>72||password.includes('\0'))throw fail('密码至少 12 位，UTF-8 长度不超过 72 字节；建议使用系统生成的随机密码。');
  return password;
}
async function rpc(db:ReturnType<typeof database>,name:string,args:Account){const {data,error}=await db.rpc(name,args);if(error)throw fail(error.code==='P0001'?error.message:error.code==='23505'?'账号名或书库已经分配。':'账号数据库操作失败，请确认账号迁移已部署。',error.code==='P0001'?403:error.code==='23505'?409:503);return data;}
async function account(db:ReturnType<typeof database>,name:string){const {data,error}=await db.from('scribe_accounts').select('*').eq('username',name).maybeSingle();if(error)throw fail('账号服务尚未部署，请联系管理员完成账号数据库迁移。',503);return data;}
async function provision(db:ReturnType<typeof database>,body:Account,actor:string|null,owner=false,library:string|null=null){
  const username=String(body.username||'').trim().toLowerCase();if(!validName(username))throw fail('账号需为 3–32 位小写英文字母、数字、点、下划线或短横线。');
  if(await account(db,username))throw fail('此账号已存在，请换一个账号名。',409);
  const password=passwordFor(body),email=crypto.randomUUID()+'@accounts.scribe.invalid';
  const {data,error}=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{scribe_managed:true}});
  if(error||!data.user)throw fail('账号创建失败，请稍后重试。',503);
  try{
    const created=await rpc(db,'scribe_create_account',{p_id:data.user.id,p_username:username,p_name:String(body.displayName||username).slice(0,80),p_email:email,p_actor:actor,p_owner:owner,p_library:library});
    return {account:created,password};
  }catch(error){
    // Only remove the Auth identity just created by THIS request, never an existing user's data.
    await db.auth.admin.deleteUser(data.user.id);throw error;
  }
}

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return json({ok:true});
  if(req.method!=='POST')return json({error:'不支持的操作。'},405);
  try{
    const body=await readJsonLimited(req,16384),db=database(),action=String(body.action||'');
    if(action==='login'){
      const username=String(body.username||'').trim().toLowerCase(),password=String(body.password||'');
      if(!validName(username)||!password||new TextEncoder().encode(password).length>72||password.includes('\0'))throw fail('账号或密码不正确。',401);
      const allowed=await rpc(db,'scribe_login_allowed',{p_bucket:'user:'+await hashKey(username),p_limit:30});
      const globallyAllowed=await rpc(db,'scribe_login_allowed',{p_bucket:'global',p_limit:600});
      if(!allowed||!globallyAllowed)throw fail('尝试次数过多，请 15 分钟后再试。',429);
      let profile=await account(db,username);
      const ownerName=(Deno.env.get('SCRIBE_ADMIN_USERNAME')||'admin').trim().toLowerCase();
      if(!profile&&username===ownerName){
        const secret=Deno.env.get('SCRIBE_ADMIN_PASSWORD')||'';
        if(!secret)throw fail('最高管理员尚未初始化，请在云端安全设置管理员账号与密码。',503);
        if(secret.length<12||new TextEncoder().encode(secret).length>72||secret.includes('\0'))throw fail('管理员初始密码需至少 12 位且不超过 72 个 UTF-8 字节，请在云端安全设置中修改。',503);
        if(secret.length>=12&&safeEqual(password,secret)){
          const {data:existing,error}=await db.from('scribe_accounts').select('id').eq('role','owner').maybeSingle();
          if(error)throw fail('账号服务暂不可用。',503);
          if(!existing)profile=(await provision(db,{username,password,displayName:'最高管理员'},null,true)).account;
        }
      }
      // Even unknown usernames go through Auth; response does not disclose user existence.
      const verifier=database();
      const {data,error}=await verifier.auth.signInWithPassword({email:profile?.auth_email||'unknown@accounts.scribe.invalid',password});
      if(data.session?.access_token)await verifier.auth.admin.signOut(data.session.access_token,'local');
      if(error||!profile||!data.user||data.user.id!==profile.id||profile.disabled)throw fail('账号或密码不正确，或账号已停用。',401);
      const token=randomKey();
      const issued=await rpc(db,'scribe_issue_account_session',{p_id:profile.id,p_hash:await hashKey(token),p_version:profile.credential_version});
      if(!issued)throw fail('账号状态已变化，请重新登录。',401);
      return json({token,user:summary(profile),expiresAt:new Date(Date.now()+12*3600000).toISOString()});
    }
    const identity=await libraryFor(db,body.token);
    if(!identity)throw fail('请先登录，或登录已过期。',401);
    if(action==='me')return json({user:{id:identity.accountId,username:identity.username,displayName:identity.displayName,role:identity.role,libraryId:identity.id}});
    if(action==='logout'){
      const {error}=await db.from('scribe_account_sessions').delete().eq('token_hash',await hashKey(String(body.token)));
      if(error)throw fail('退出失败，请重试。',503);return json({ok:true});
    }
    if(identity.role!=='owner')throw fail('只有最高管理员可以管理账号。',403);
    if(action==='list'){
      const accounts=await allRows((from,to)=>db.from('scribe_accounts').select('id,username,display_name,role,disabled,library_id,created_at,last_login_at').order('created_at',{ascending:false}).order('id').range(from,to));
      return json({accounts:accounts.map(summary)});
    }
    if(action==='audit'){
      const {data,error}=await db.from('scribe_account_audit').select('id,actor_id,target_id,action,created_at').order('id',{ascending:false}).limit(50);
      if(error)throw fail('操作记录读取失败。',503);return json({events:data||[]});
    }
    if(action==='create'){
      if(body.role&&body.role!=='member')throw fail('不允许通过用户创建接口提升权限。',403);
      let legacy:string|null=null;
      if(body.legacyLibraryKey){
        const old=String(body.legacyLibraryKey);if(!/^[a-f0-9]{64}$/.test(old))throw fail('旧书库同步码格式不正确。');
        const hash=await hashKey(old);
        const {data:original,error}=await db.from('scribe_libraries').select('id').eq('access_hash',hash).maybeSingle();if(error)throw fail('旧书库查询失败。',503);
        if(original)legacy=original.id;else{
          const {data:access,error}=await db.from('scribe_library_access').select('library_id').eq('access_hash',hash).maybeSingle();if(error)throw fail('旧书库查询失败。',503);legacy=access?.library_id||null;
        }
        if(!legacy)throw fail('未找到旧书库，未创建账号。');
        const {data:claimed,error:claimedError}=await db.from('scribe_accounts').select('id').eq('library_id',legacy).maybeSingle();if(claimedError)throw fail('旧书库查询失败。',503);if(claimed)throw fail('该书库已经绑定账号，不能重复分配。',409);
      }
      const created=await provision(db,body,identity.accountId,false,legacy);
      return json({user:summary(created.account),credentials:{username:created.account.username,password:created.password}},201);
    }
    if(['disable','enable','resetPassword'].includes(action)){
      const target=String(body.id||'');if(!/^[a-f0-9-]{36}$/i.test(target))throw fail('账号标识不正确。');
      const password=action==='resetPassword'?passwordFor(body):'';
      await rpc(db,'scribe_manage_account',{p_actor:identity.accountId,p_target:target,p_action:action==='resetPassword'?'reset_password':action});
      if(action==='resetPassword'){
        const {error}=await db.auth.admin.updateUserById(target,{password});
        if(error)throw fail('旧会话已退出，但新密码设置失败，请重新重置。',503);
        const {data,error:lookupError}=await db.from('scribe_accounts').select('username').eq('id',target).single();if(lookupError)throw fail('密码已重置，请重新设置并保存凭据。',503);
        return json({credentials:{username:data.username,password}});
      }
      return json({ok:true});
    }
    return json({error:'不支持的操作；本站不提供公开注册。'},400);
  }catch(error){
    // Do not log request bodies, credentials, sessions or Auth error details.
    return json({error:error instanceof Error?error.message:'账号服务暂不可用。'},Number((error as {status?:number}).status)||500);
  }
});
