/**
 * 역할: .vid_env를 읽어서 process.env에 주입
 * 인자: 없음
 * 반환: 없음
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 서비스 루트: .../VIDEO-PROCESSOR-SERVICE
const serviceRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(serviceRoot, ".vid_env") });

const HELLO = process.env.HELLO;
console.log(HELLO)

// 선택: 로컬 오버라이드가 필요하면(없으면 빼도 됨)
// dotenv.config({ path: path.join(serviceRoot, ".vid_env.local") });
