try {
    require('../bot.js');
    console.log("Syntax OK");
} catch (e) {
    console.log("Syntax Error Detected:");
    console.log(e.message);
    if (e.stack) console.log(e.stack);
}
