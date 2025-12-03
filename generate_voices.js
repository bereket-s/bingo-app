const googleTTS = require('google-tts-api');
const fs = require('fs');
const path = require('path');

const LANGUAGES = ['en', 'am'];

const CONFIG = {
    en: {
        prefixes: { B: "B", I: "I", N: "N", G: "G", O: "O" },
        phrases: {
            bingo: "Bingo!",
            card: "The winning card number is",
            win: "We have a winner!",
            welcome: "Welcome to the game. Please wait.",
            voice_on: "Voice is now on"
        }
    },
    am: {
        // Phonetic sounds for B-I-N-G-O in Amharic
        prefixes: { B: "ቢ", I: "አይ", N: "ኤን", G: "ጂ", O: "ኦው" },
        phrases: {
            bingo: "ቢንጎ!",
            card: "ያሸነፈው ካርቴላ ቁጥር",
            win: "አሸናፊ አለን!",
            welcome: "እንኳን ደህና መጡ።",
            voice_on: "ድምጽ በርቷል"
        }
    }
};

async function generateAudio() {
    console.log("🚀 Starting Audio Generation...");

    for (const lang of LANGUAGES) {
        const folder = path.join(__dirname, 'public', 'audio', lang);
        
        // Create folder if it doesn't exist
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
        }

        console.log(`\nmic Generating ${lang.toUpperCase()} files in ${folder}...`);
        const settings = CONFIG[lang];

        // 1. Generate Simple Numbers (1-100) for Card IDs
        // File: 1.mp3, 2.mp3...
        for (let i = 1; i <= 500; i++) {
            await saveAudio(String(i), lang, path.join(folder, `${i}.mp3`));
            if (i % 20 === 0) process.stdout.write('.');
        }

        // 2. Generate Game Calls (B1-O75)
        // File: call_1.mp3, call_2.mp3...
        for (let i = 1; i <= 75; i++) {
            let prefix = "";
            if (i <= 15) prefix = settings.prefixes.B;
            else if (i <= 30) prefix = settings.prefixes.I;
            else if (i <= 45) prefix = settings.prefixes.N;
            else if (i <= 60) prefix = settings.prefixes.G;
            else prefix = settings.prefixes.O;

            const text = `${prefix} ${i}`;
            await saveAudio(text, lang, path.join(folder, `call_${i}.mp3`));
            if (i % 20 === 0) process.stdout.write('.');
        }

        // 3. Generate Phrases
        for (const [filename, text] of Object.entries(settings.phrases)) {
            await saveAudio(text, lang, path.join(folder, `${filename}.mp3`));
        }
    }
    console.log("\n\n✅ DONE! All audio files created successfully.");
}

async function saveAudio(text, lang, filePath) {
    try {
        // Get base64 audio from Google TTS
        const base64 = await googleTTS.getAudioBase64(text, {
            lang: lang,
            slow: false,
            host: 'https://translate.google.com',
            timeout: 10000,
        });
        
        // Write to file
        const buffer = Buffer.from(base64, 'base64');
        fs.writeFileSync(filePath, buffer);
    } catch (e) {
        console.error(`\n❌ Error generating "${text}":`, e.message);
    }
}

generateAudio();