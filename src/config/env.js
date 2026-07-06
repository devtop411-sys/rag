import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve .env from the project root regardless of the process CWD.
dotenv.config({ path: join(__dirname, "../../.env"), override: true });
