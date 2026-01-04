import pino from 'pino';

// 1. 단 하나의 루트 로거 엔진을 생성합니다.
const rootLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      sync: true, // 여기서 딱 한 번만 설정
      colorize: true,
      ignore: "pid,hostname,time",
      messageFormat: "[{name}] {msg}",
      translateTime: false
    }
  }
});

/**
 * [함수 책임] 기존 루트 로거의 자식 로거를 생성하여 반환
 * @param {string} name 모듈명
 */
export function createLogger(name) {
  // 2. 새로운 인스턴스를 만드는 게 아니라, 루트 로거의 '자식'을 만듭니다.
  // 이렇게 하면 설정은 공유하면서 [name]만 바뀝니다.
  return rootLogger.child({ name });
}