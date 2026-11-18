import dotenv from "dotenv";
// .env ищется в текущей папке и в корне backend (при запуске через npm workspaces cwd = apps/server)
dotenv.config();
dotenv.config({ path: new URL("../../../.env", import.meta.url).pathname });
