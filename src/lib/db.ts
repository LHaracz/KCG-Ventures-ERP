import { init } from "@instantdb/react";
import schema from "../../instant.schema";

const APP_ID = "YOUR_APP_ID_HERE";

export const db = init({
  appId: APP_ID,
  schema,
});

