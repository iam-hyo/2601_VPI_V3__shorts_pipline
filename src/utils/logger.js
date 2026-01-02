/**
 * [파일 책임]
 * - pino 기반 로거를 생성합니다.
 */

import pino from "pino";

/**
 * [함수 책임] 로거 생성
 * @param {string} name 모듈명
 * @returns {import('pino').Logger}
 */
export function createLogger(name) {
  const isProd = process.env.NODE_ENV === "production";
  return pino({
    name,
    level: process.env.LOG_LEVEL || "info",
    transport: isProd
      ? undefined
      : {
          target: "pino-pretty",
          options: { translateTime: "SYS:standard", ignore: "pid,hostname" }
        }
  });
}
