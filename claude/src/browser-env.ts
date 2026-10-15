/**
 * 交给浏览器子进程的环境变量:本进程环境去掉密钥类变量后的副本。
 *
 * 浏览器默认继承本进程的全部环境,而托管工位的环境里有 MCP_AUTH_TOKEN、ADMIN_TOKEN、BAOLEI_MCP_TOKEN / URL、
 * SELKIES_* 密码等 —— 渲染进程被攻破、或者扩展 / 崩溃转储里带出环境,就全漏了。浏览器用不到它们。
 * 本进程自己的 process.env 不动(配置模块照常读),只给子进程一份过滤后的。
 */

type Env = Record<string, string | undefined>;

/** 名字像密钥的变量:令牌 / 密码 / 密钥 / 私钥,以及堡垒机、远程画面的全部配置 */
const SENSITIVE = /TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|_KEY$|^BAOLEI_|^SELKIES_/i;

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE.test(name);
}

export function browserEnv(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !isSensitiveEnvName(k)) out[k] = v;
  }
  return out;
}
