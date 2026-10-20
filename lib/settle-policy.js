/** 官方桌面启动时 Fiber._reload 还在挂 desktop-office，settle 不得解包/杀进程。 */

export const DESKTOP_SETTLE_DELAY_MS = 4000;

export function isInactiveContextError(error) {
  if (!error) return false;
  if (error.code === "INACTIVE_EFFECT") return true;
  return /inactive context/i.test(String(error.message || error));
}

export function watchContextLife(ctx) {
  const life = { alive: true };
  if (!ctx || typeof ctx.effect !== "function") return life;
  try {
    ctx.effect(() => () => {
      life.alive = false;
    });
  } catch (error) {
    if (isInactiveContextError(error)) {
      life.alive = false;
      return life;
    }
    throw error;
  }
  return life;
}

export function settleDelayMs(surface) {
  return surface === "desktop" ? DESKTOP_SETTLE_DELAY_MS : 0;
}

/** 桌面启动自愈不得 requestRestart / taskkill，否则 Cordis 会 INACTIVE_EFFECT。 */
export function settleMayRestart({ surface, sealed = false } = {}) {
  if (surface === "desktop") return false;
  if (sealed) return false;
  return true;
}

/** 密封 asar 上就地 extract/swap 会和官方 Host 的 Fiber._reload 抢锁。 */
export function settleMayReapply({ surface, sealed = false } = {}) {
  if (surface === "desktop" && sealed) return false;
  return true;
}

/**
 * 点「应用」后是否重启。
 *
 * 为什么需要重启
 * --------------
 * 补丁是用字符串替换直接改宿主磁盘上的 @deepseek-ai/ 包源码，而那些模块
 * 在进程启动时已经 import 进内存并缓存。改磁盘不影响已加载的代码，所以**改写补丁
 * 必须重启**才能让新代码生效。密封 asar 还要额外换包，更是只能重启。
 *
 * 什么时候**不需要**重启
 * --------------------
 * 提示词、规则集、会话注入开关都是每轮从磁盘读取的（readInjectFallback 带 200ms
 * mtime 节流），改完下一轮就生效。所以「这次没写任何补丁、只更新了提示词」时重启
 * 是多余的 —— 它只会打断用户的工作。
 *
 *  就是表达这件事：调用方确认提示词已落盘且不需要重启时传 true，
 * 我们就不再因为 promptReady 而重启。默认 false 保持旧行为，避免老调用点意外改变语义。
 *
 * 冷却不放在这里——否则第一次重启没换掉 asar，第二次应用会被当成取消。
 */
export function applyShouldRestart({
  complete = false,
  sealed = false,
  appliedCount = 0,
  promptReady = false,
  promptIsHot = false,
} = {}) {
  // 密封桌面：点「应用」后必须完全退出才能换 asar / 加载 resources/app，与补丁是否标 applied 无关。
  if (sealed) return true;
  // 写了补丁就必须重启：改的是进程内已加载的源码。
  if (Number(appliedCount) > 0) return true;
  // 提示词已经热生效，就没必要为了它重启。
  if (promptIsHot && !complete) return false;
  if (complete || promptReady) return true;
  return false;
}

/**
 * 给 UI / 日志用的一句话解释：这次为什么重启（或为什么不重启）。
 *
 * @param {object} input same shape as applyShouldRestart
 * @returns {string} reason key
 */
export function restartReason(input = {}) {
  if (input.sealed) return "sealed-asar";
  if (Number(input.appliedCount) > 0) return "patches-written";
  if (input.promptIsHot && !input.complete) return "none-prompt-hot";
  if (input.complete || input.promptReady) return "prompt-written";
  return "none";
}
