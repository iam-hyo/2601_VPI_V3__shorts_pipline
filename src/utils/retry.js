/**
 * [파일 책임]
 * - Exponential Backoff + Jitter 재시도 유틸을 제공합니다.
 */

import { RETRY } from "../config.js";

/**
 * [함수 책임] sleep
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(ms) {
  const jitter = Math.random() * 0.3 + 0.85;
  return Math.floor(ms * jitter);
}

/**
 * [함수 책임] 비동기 함수를 재시도하며 실행합니다.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} label
 * @returns {Promise<T>}
 */
export async function withRetry(fn, label = "retry") {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY.maxAttempts) throw err;
      const delay = Math.min(RETRY.maxDelayMs, RETRY.baseDelayMs * Math.pow(2, attempt - 1));
      await sleep(withJitter(delay));
    }
  }
}
