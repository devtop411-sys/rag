import dotenv from "dotenv";

dotenv.config({ override: true });

console.log(process.env.AWS_ACCESS_KEY_ID);
console.log("test22312", process.env.AWS_SECRET_ACCESS_KEY?.length);
