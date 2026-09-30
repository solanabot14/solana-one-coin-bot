require("dotenv").config();
const bot = require("./botR3");

bot.startBot();

process.on("SIGINT", () => {
  bot.stopBot();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stopBot();
  process.exit(0);
});
