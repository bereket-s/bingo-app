import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import BingoCard from "./BingoCard";
import "./App.css";

// Error Boundary to catch loading failures
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        console.error("React Error Boundary caught:", error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="App login-screen" style={{ padding: '20px', textAlign: 'center' }}>
                    <h2>⚠️ Loading Error</h2>
                    <p>Something went wrong. Please try:</p>
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                        <li>✓ Refresh the page (F5)</li>
                        <li>✓ Clear browser cache</li>
                        <li>✓ Check your internet connection</li>
                        <li>✓ Reopen from Telegram</li>
                    </ul>
                    <button
                        onClick={() => window.location.reload()}
                        style={{ padding: '10px 20px', fontSize: '16px', marginTop: '20px', cursor: 'pointer' }}
                    >
                        🔄 Reload Page
                    </button>
                    <details style={{ marginTop: '20px', fontSize: '12px', color: '#666' }}>
                        <summary>Technical Details</summary>
                        <pre style={{ textAlign: 'left', overflow: 'auto' }}>
                            {this.state.error?.toString()}
                        </pre>
                    </details>
                </div>
            );
        }
        return this.props.children;
    }
}

const socket = io();
const MAX_CARDS = 5;

const TRANSLATIONS = {
    en: {
        waiting: "Waiting for host...",
        voiceOn: "🔊 ON",
        voiceOff: "🔇 OFF",
        hintOn: "Voice active!",
        hintOff: "🔊 Tap to enable voice!",
        settings: "⚙️ Settings",
        autoDaubLbl: "Auto Daub",
        autoBingoLbl: "Auto Bingo",
        premOnly: "(Premium Only)",
        save: "Save",
        hostMsg: "Host will start the game soon.",
        bet: "Bet",
        prizeLabel: "Prize is ",
        currency: " Birr",
        pattern: "Winning Pattern",
        myCards: "My Cards",
        reqCards: "Buy Cards",
        pickCard: "Pick a Card:",
        customBtn: "Go",
        confirm: "Confirm",
        back: "Back",
        bingo: "BINGO!",
        checking: "Checking...",
        winner: "Winner",
        won: "won",
        gameId: "Game #",
        invalid: "Open via Telegram.",
        maxCards: "Max reached!",
        lastCalled: "LAST",
        cardView: "👁",
        locked: "🔒",
        langBtn: "🇪🇹 አማርኛ",
        premium: "Premium",
        watching: "Watching...",
        cardNo: "Card #",
        gameClosed: "Game Closed",
        p_any_line: "Any One Line (or Corners)", p_two_lines: "Two Lines (Corners = 1 Line)", p_x_shape: "X Shape",
        p_l_shape: "L Shape", p_corners: "4 Corners", p_letter_h: "Letter H",
        p_letter_t: "Letter T", p_frame: "Frame", p_full_house: "Full House",
        p_plus_sign: "Plus Sign", p_u_shape: "U Shape",
        buyPoints: "🛒 Buy Points"
    },
    am: {
        waiting: "አስተናጋጁ እስኪጀምር...",
        voiceOn: "🔊 በርቷል",
        voiceOff: "🔇 አጥፋ",
        hintOn: "ድምጽ በርቷል!",
        hintOff: "🔊 ድምጽ ለመስማት ይጫኑ!",
        settings: "⚙️ መቼቶች",
        autoDaubLbl: "ራሱ ይምረጥ (Auto)",
        autoBingoLbl: "ራሱ ቢንጎ ይበል",
        premOnly: "(ለፕሪሚየም ብቻ)",
        save: "አስቀምጥ",
        hostMsg: "ተጫዋቾችን በመጠበቅ ላይ",
        bet: "መወራረጃ",
        prizeLabel: "ደራሽ ",
        currency: " ብር",
        pattern: "የአሸናፊነት ህግ",
        myCards: "የኔ ካርዶች",
        reqCards: "ካርድ ይግዙ",
        pickCard: "ካርድ ይምረጡ:",
        customBtn: "ሂድ",
        confirm: "አረጋግጥ",
        back: "ተመለስ",
        bingo: "ቢንጎ!",
        checking: "በማጣራት ላይ...",
        winner: "አሸናፊ",
        won: "አሸንፏል",
        gameId: "ጨዋታ #",
        invalid: "በቴሌግራም ይክፈቱ",
        maxCards: "ከፍተኛ የካርድ ብዛት!",
        lastCalled: "የተጠራው",
        cardView: "👁",
        locked: "🔒",
        langBtn: "🇺🇸 English",
        premium: "ፕሪሚየም",
        watching: "ጨዋታውን በመከታተል ላይ...",
        cardNo: "ካርድ #",
        gameClosed: "ጨዋታው ተዘግቷል",
        p_any_line: "ማንኛውም 1 መስመር (ወይም ኮርነር)", p_two_lines: "ሁለት መስመር (ኮርነር እንደ 1)", p_x_shape: "X ቅርጽ",
        p_l_shape: "L ቅርጽ", p_corners: "4ቱ ማዕዘን", p_letter_h: "H ቅርጽ",
        p_letter_t: "T ቅርጽ", p_frame: "ዙሪያውን/ሣጥን", p_full_house: "ፉል ሀውስ (ሙሉ)",
        p_plus_sign: "Plus +", p_u_shape: "U Shape (Pyramid)",
        buyPoints: "🛒 ነጥብ ይግዙ"
    }
};

const getT = (lang) => (key) => TRANSLATIONS[lang][key] || TRANSLATIONS['en'][key] || key;

// Helper to format numbers like "B 5", "I 20" for display
const formatBingoNum = (n) => {
    const num = parseInt(n);
    if (!num) return "..";
    if (num <= 15) return `B${num}`;
    if (num <= 30) return `I${num}`;
    if (num <= 45) return `N${num}`;
    if (num <= 60) return `G${num}`;
    return `O${num}`;
};

const PatternDisplay = ({ pattern, t }) => {
    const [frame, setFrame] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setFrame(f => (f + 1) % 4);
        }, 800);
        return () => clearInterval(interval);
    }, []);

    const getGrid = (p, f) => {
        const g = Array(5).fill(null).map(() => Array(5).fill(false));
        const fill = (r, c) => { if (r >= 0 && r < 5 && c >= 0 && c < 5) g[r][c] = true; };

        if (p === 'any_line') {
            if (f === 0) for (let c = 0; c < 5; c++) fill(2, c);
            if (f === 1) for (let r = 0; r < 5; r++) fill(r, 2);
            if (f === 2) for (let i = 0; i < 5; i++) fill(i, i);
            if (f === 3) { fill(0, 0); fill(0, 4); fill(4, 0); fill(4, 4); }
        }
        else if (p === 'x_shape') { for (let i = 0; i < 5; i++) { fill(i, i); fill(i, 4 - i); } }
        else if (p === 'two_lines') {
            if (f % 4 === 0) { for (let c = 0; c < 5; c++) { fill(0, c); fill(1, c); } }
            else if (f % 4 === 1) { for (let r = 0; r < 5; r++) { fill(r, 0); fill(r, 4); } }
            else if (f % 4 === 2) { for (let i = 0; i < 5; i++) { fill(i, i); fill(i, 4 - i); } }
            else { for (let c = 0; c < 5; c++) fill(2, c); fill(0, 0); fill(0, 4); fill(4, 0); fill(4, 4); }
        }
        else if (p === 'l_shape') { for (let r = 0; r < 5; r++) fill(r, 0); for (let c = 0; c < 5; c++) fill(4, c); }
        else if (p === 'corners') { if (f % 2 === 0) { fill(0, 0); fill(0, 4); fill(4, 0); fill(4, 4); } }
        else if (p === 'letter_h') { for (let r = 0; r < 5; r++) { fill(r, 0); fill(r, 4); } fill(2, 1); fill(2, 2); fill(2, 3); }
        else if (p === 'letter_t') { for (let c = 0; c < 5; c++) fill(0, c); for (let r = 0; r < 5; r++) fill(r, 2); }
        else if (p === 'frame') { for (let i = 0; i < 5; i++) { fill(0, i); fill(4, i); fill(i, 0); fill(i, 4); } }
        else if (p === 'plus_sign') { for (let i = 0; i < 5; i++) { fill(2, i); fill(i, 2); } }
        else if (p === 'u_shape') { for (let i = 0; i < 5; i++) { fill(i, 0); fill(i, 4); } for (let c = 0; c < 5; c++) fill(4, c); }
        else if (p === 'full_house') { for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) fill(r, c); }
        return g;
    };

    const grid = getGrid(pattern, frame);
    return (
        <div className="pattern-visual">
            <div className="mini-grid">
                {grid && grid.map((row, r) => (
                    <div key={r} className="mini-row">
                        {row.map((active, c) => (
                            <div key={c} className={`mini-cell ${active ? 'active' : ''}`} />
                        ))}
                    </div>
                ))}
            </div>
            <div className="pattern-name">{t('p_' + pattern) || pattern.replace('_', ' ').toUpperCase()}</div>
        </div>
    );
};

function App() {
    const [lang, setLang] = useState(localStorage.getItem('bingo_lang') || 'en');
    const langRef = useRef(lang);

    const [auth, setAuth] = useState(null);
    const [player, setPlayer] = useState(null);
    const [prefs, setPrefs] = useState({ autoDaub: true, autoBingo: true });

    const [gameState, setGameState] = useState({ status: "idle", gameId: null, displayId: null, betAmount: 0, calledNumbers: [], winner: null, pot: 0, pattern: "any_line", startTime: null });

    const [showSettings, setShowSettings] = useState(false);
    const [cardOptions, setCardOptions] = useState([]);
    const [cardStates, setCardStates] = useState({});
    const [selectedOption, setSelectedOption] = useState(null);
    const [myCards, setMyCards] = useState([]);
    const [markedCells, setMarkedCells] = useState({});
    const [errorMsg, setErrorMsg] = useState("");
    const [checkingCardId, setCheckingCardId] = useState(null);
    const [customCardNum, setCustomCardNum] = useState("");
    const [countdown, setCountdown] = useState(0);
    const [isConfirming, setIsConfirming] = useState(false);

    const [audioEnabled, setAudioEnabled] = useState(false);
    const audioEnabledRef = useRef(false);
    const audioRef = useRef(new Audio());
    const audioQueue = useRef([]);
    const isPlaying = useRef(false);
    const isSubmittingRef = useRef(false);
    const lastGameId = useRef(null);

    const t = getT(lang);

    useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);
    useEffect(() => { langRef.current = lang; }, [lang]);

    useEffect(() => {
        if (gameState.gameId) {
            const savedMarks = localStorage.getItem(`bingo_marks_${gameState.gameId}`);
            if (savedMarks) {
                const parsed = JSON.parse(savedMarks);
                const restored = {};
                Object.keys(parsed).forEach(key => restored[key] = new Set(parsed[key]));

                setMarkedCells(prev => {
                    const combined = { ...prev };
                    Object.keys(restored).forEach(key => {
                        if (combined[key]) {
                            restored[key].forEach(val => combined[key].add(val));
                        } else {
                            combined[key] = restored[key];
                        }
                    });
                    return combined;
                });
            }
        }
    }, [gameState.gameId]);

    useEffect(() => {
        if (gameState.gameId && Object.keys(markedCells).length > 0) {
            const serializable = {};
            Object.keys(markedCells).forEach(key => serializable[key] = Array.from(markedCells[key]));
            localStorage.setItem(`bingo_marks_${gameState.gameId}`, JSON.stringify(serializable));
        }
    }, [markedCells, gameState.gameId]);

    useEffect(() => {
        if (gameState.status === 'idle') {
            setMyCards([]);
            setMarkedCells({});
            setCardOptions([]);
            setCardStates({});
            setSelectedOption(null);
            setCheckingCardId(null);
            setCustomCardNum("");
            setIsConfirming(false);
            if (gameState.gameId) localStorage.removeItem(`bingo_marks_${gameState.gameId}`);
        }
    }, [gameState.status, gameState.gameId]);

    useEffect(() => {
        const unlockAudio = () => {
            if (audioRef.current) {
                audioRef.current.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
                audioRef.current.play().catch(() => { });
            }
            window.removeEventListener('click', unlockAudio);
            window.removeEventListener('touchstart', unlockAudio);
        };
        window.addEventListener('click', unlockAudio);
        window.addEventListener('touchstart', unlockAudio);
        return () => {
            window.removeEventListener('click', unlockAudio);
            window.removeEventListener('touchstart', unlockAudio);
        };
    }, []);

    useEffect(() => {
        if (!document.getElementById('confetti-script')) {
            const script = document.createElement('script');
            script.id = 'confetti-script';
            script.src = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js";
            script.async = true;
            document.body.appendChild(script);
        }
    }, []);

    const triggerConfetti = () => {
        if (window.confetti) window.confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    };

    const processAudioQueue = async () => {
        if (isPlaying.current || audioQueue.current.length === 0) return;
        isPlaying.current = true;

        const filename = audioQueue.current.shift();
        audioRef.current.src = `/audio/${langRef.current}/${filename}.mp3`;

        try {
            await audioRef.current.play();
            audioRef.current.onended = () => {
                isPlaying.current = false;
                processAudioQueue();
            };
        } catch (e) {
            console.error("Audio play error", e);
            isPlaying.current = false;
            processAudioQueue();
        }
    };

    const queueAudio = (filenames) => {
        if (!audioEnabledRef.current) return;
        if (Array.isArray(filenames)) {
            audioQueue.current.push(...filenames);
        } else {
            audioQueue.current.push(filenames);
        }
        processAudioQueue();
    };

    useEffect(() => {
        if (gameState.calledNumbers.length > 0) {
            const lastNum = gameState.calledNumbers[gameState.calledNumbers.length - 1];
            queueAudio(`call_${lastNum}`);

            if (player.isPremium && prefs.autoDaub && gameState.status === 'active') {
                setMarkedCells(prev => {
                    const newMarked = { ...prev };
                    let changed = false;
                    myCards.forEach(card => {
                        const cardSet = new Set(newMarked[card.id] || ['FREE']);
                        gameState.calledNumbers.forEach(calledNum => {
                            const calledStr = String(calledNum);
                            if (!cardSet.has(calledStr)) {
                                let existsOnCard = false;
                                card.card_data.forEach(row => row.forEach(cell => { if (String(cell) === calledStr) existsOnCard = true; }));
                                if (existsOnCard) {
                                    cardSet.add(calledStr);
                                    changed = true;
                                }
                            }
                        });
                        if (changed) newMarked[card.id] = cardSet;
                    });
                    return changed ? newMarked : prev;
                });
            }
        }
    }, [gameState.calledNumbers]);

    const toggleAudio = () => {
        const newState = !audioEnabled;
        setAudioEnabled(newState);
        if (newState) {
            audioRef.current.src = `/audio/${langRef.current}/voice_on.mp3`;
            audioRef.current.play().catch(e => console.log("Voice conf failed", e));
        }
    };

    const toggleLanguage = () => {
        const newLang = lang === 'en' ? 'am' : 'en';
        setLang(newLang);
        localStorage.setItem('bingo_lang', newLang);
    };

    const toggleSettings = () => setShowSettings(!showSettings);
    const togglePref = (key) => {
        const newVal = !prefs[key];
        setPrefs(prev => ({ ...prev, [key]: newVal }));
        if (player.isPremium) socket.emit('updatePreferences', { ...prefs, [key]: newVal });
    };

    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const userId = urlParams.get('user_id');
        const token = urlParams.get('token');
        if (userId && token) { setAuth({ userId: parseInt(userId, 10), token }); }
        else if (window.location.search.includes('user_id')) { setErrorMsg(t('invalid')); }

        // Initial Connection Check with error handling
        const handleConnectionError = (error) => {
            console.error('Socket connection error:', error);
            setErrorMsg('Connection error. Please refresh.');
        };

        socket.on('connect_error', handleConnectionError);
        socket.on('connect_failed', handleConnectionError);

        if (socket.connected) {
            socket.emit('joinCheck');
        } else {
            socket.on('connect', () => socket.emit('joinCheck'));
        }

        return () => {
            socket.off('connect_error', handleConnectionError);
            socket.off('connect_failed', handleConnectionError);
        };
    }, []);

    useEffect(() => {
        if (!auth || gameState.status !== 'pending') return;
        if (selectedOption) socket.emit('viewCard', { gameId: gameState.gameId, cardId: selectedOption.id, isViewing: true });
        return () => { if (selectedOption) socket.emit('viewCard', { gameId: gameState.gameId, cardId: selectedOption.id, isViewing: false }); };
    }, [selectedOption, auth, gameState.gameId, gameState.status]);

    useEffect(() => {
        const handleReconnection = () => { if (auth) socket.emit("syncGameState", auth); };

        if (auth) {
            socket.emit("syncGameState", auth);
            socket.on('connect', handleReconnection);
            socket.on('reconnect', handleReconnection);
            window.addEventListener('focus', handleReconnection);
        }

        socket.on("playerUpdate", (data) => {
            setPlayer(prev => ({ ...prev, ...data }));
            if (data.prefAutoDaub !== undefined) setPrefs({ autoDaub: data.prefAutoDaub, autoBingo: data.prefAutoBingo });
        });

        socket.on("potUpdate", (data) => setGameState(prev => ({ ...prev, pot: data.pot })));
        socket.on("cardStatesUpdate", (updates) => setCardStates(prev => ({ ...prev, ...updates })));

        socket.on("gameStateUpdate", (data) => {
            // DETECT NEW GAME
            if (data.gameId && data.gameId !== lastGameId.current) {
                lastGameId.current = data.gameId;
                // Reset UI for new game
                setCardOptions([]);
                setSelectedOption(null);
                setCardStates({});
                setIsConfirming(false);
                setCheckingCardId(null);
                // Only clear cards if server didn't send new ones (e.g. reconnect)
                if (!data.myCards) {
                    setMyCards([]);
                    setMarkedCells({});
                }
            }

            setGameState(prev => ({ ...prev, ...data }));

            if (data.status === 'finished' && data.winner && !gameState.winner) {
                queueAudio('win');
            }

            if (data.myCards) {
                setMyCards(data.myCards);
                setMarkedCells(prev => {
                    if (Object.keys(prev).length > 0) return prev;
                    const newMarked = {};
                    data.myCards.forEach(card => { newMarked[card.id] = new Set(['FREE']); });
                    return newMarked;
                });
            }
        });

        socket.on("gameCountdown", ({ seconds, startTime }) => {
            setGameState(prev => ({ ...prev, startTime }));
        });

        socket.on("numberCalled", ({ allCalled }) => setGameState(prev => ({ ...prev, calledNumbers: allCalled })));
        socket.on("cardOptions", ({ options, bet }) => { setCardOptions(options.sort((a, b) => a.id - b.id)); setGameState(prev => ({ ...prev, betAmount: bet })); });

        socket.on("joinSuccess", ({ card }) => {
            setIsConfirming(false);
            setMyCards(prev => [...prev, card]);
            setMarkedCells(prev => ({ ...prev, [card.id]: new Set(['FREE']) }));
            setSelectedOption(null);
        });

        socket.on("bingoResult", ({ valid, message, isWinner, winningCardId }) => {
            setCheckingCardId(null);
            if (isWinner) triggerConfetti();
            if (winningCardId) { queueAudio(['bingo', 'card', String(winningCardId)]); }
            if (!valid) { setErrorMsg(message || "Error"); setTimeout(() => setErrorMsg(""), 4000); }
        });

        socket.on("error", (msg) => {
            setIsConfirming(false);
            if (msg.message?.includes('Authentication')) setAuth(null);
            setErrorMsg(msg.message || "Error");
            setTimeout(() => setErrorMsg(""), 3000);
        });

        return () => {
            socket.off("playerUpdate"); socket.off("potUpdate"); socket.off("gameStateUpdate"); socket.off("numberCalled");
            socket.off("cardOptions"); socket.off("joinSuccess"); socket.off("bingoResult"); socket.off("error");
            socket.off("cardStatesUpdate"); socket.off("gameCountdown");
            socket.off('connect', handleReconnection);
            socket.off('reconnect', handleReconnection);
            window.removeEventListener('focus', handleReconnection);
        };
    }, [auth, gameState.gameId]);

    useEffect(() => {
        if (gameState.startTime) {
            const interval = setInterval(() => {
                const now = Date.now();
                const remaining = Math.ceil((gameState.startTime - now) / 1000);
                if (remaining <= 0) {
                    setCountdown(0);
                    // Optionally clear start time if we want, but server will eventually send 'active' status
                } else {
                    setCountdown(remaining);
                }
            }, 1000);
            return () => clearInterval(interval);
        } else {
            setCountdown(0);
        }
    }, [gameState.startTime]);

    const requestJoin = () => auth && gameState.status === 'pending' && socket.emit("requestCards", { ...auth, gameId: gameState.gameId });
    const getSpecificCard = () => auth && gameState.status === 'pending' && customCardNum && socket.emit("requestSpecificCard", { ...auth, gameId: gameState.gameId, cardNumber: customCardNum });

    const confirmCard = () => {
        if (selectedOption && auth && !isConfirming && !isSubmittingRef.current) {
            isSubmittingRef.current = true;
            setIsConfirming(true);
            socket.emit("selectCard", { ...auth, gameId: gameState.gameId, cardGrid: selectedOption.grid, cardId: selectedOption.id });

            // Release lock after 2 seconds just in case (though component might unmount/change state)
            setTimeout(() => { isSubmittingRef.current = false; setIsConfirming(false); }, 2000);
        }
    };

    const toggleMark = (num, cardId) => {
        if (gameState.status !== 'active' || !gameState.calledNumbers.includes(String(num))) return;
        setMarkedCells(prev => {
            const newMarked = { ...prev };
            const cardSet = new Set(newMarked[cardId] || ['FREE']);
            cardSet.has(String(num)) ? cardSet.delete(String(num)) : cardSet.add(String(num));
            newMarked[cardId] = cardSet;
            return newMarked;
        });
    };
    const claimBingo = (cardId) => {
        if (!cardId || gameState.status !== 'active' || !auth) return;

        // Find the card data
        const card = myCards.find(c => c.id === cardId);
        if (!card) return;

        // Get current marked cells
        let finalMarkedCells = new Set(markedCells[cardId] || ['FREE']);

        // CRITICAL: Ensure all called numbers on this card are marked
        // This fixes race condition with auto-daub
        gameState.calledNumbers.forEach(calledNum => {
            const calledStr = String(calledNum);
            card.card_data.forEach(row => {
                row.forEach(cell => {
                    if (String(cell) === calledStr) {
                        finalMarkedCells.add(calledStr);
                    }
                });
            });
        });

        setCheckingCardId(cardId);
        socket.emit("claimBingo", { ...auth, gameId: gameState.gameId, cardId, markedCells: Array.from(finalMarkedCells) });
    };


    if (!auth) return <div className="App login-screen"><h2>{t('invalid')}</h2></div>;
    if (!player) return <div className="App login-screen"><h2>Loading... / በመጫን ላይ...</h2><div className="pulse-dot"></div></div>;

    const displayPrize = gameState.pot;

    return (
        <div className="App">
            {/* {countdown > 0 && <div className="countdown-overlay"><div className="cnt-num">{countdown}</div><div className="cnt-txt">GAME STARTING</div></div>} */}


            <header>
                <div className="header-info">
                    <span className="username">{player.username}</span>
                    <span className="points">💰 {player.points}</span>
                    {player.isPremium && <span className="premium-badge">PREMIUM</span>}
                </div>
                <div className="header-controls">
                    <button className="lang-btn" onClick={toggleSettings}>{t('settings')}</button>
                    <button className="lang-btn" onClick={toggleLanguage}>{t('langBtn')}</button>
                    <button className={`audio-btn ${audioEnabled ? 'on' : 'off'}`} onClick={toggleAudio}>{audioEnabled ? t('voiceOn') : t('voiceOff')}</button>
                </div>
            </header>

            {showSettings && (
                <div className="modal-overlay" onClick={toggleSettings}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <h3>{t('settings')}</h3>
                        <div className="setting-row">
                            <label>{t('autoDaubLbl')}</label>
                            {player.isPremium ? (
                                <input type="checkbox" checked={prefs.autoDaub} onChange={() => togglePref('autoDaub')} />
                            ) : <span className="locked-opt">🔒</span>}
                        </div>
                        <div className="setting-row">
                            <label>{t('autoBingoLbl')}</label>
                            {player.isPremium ? (
                                <input type="checkbox" checked={prefs.autoBingo} onChange={() => togglePref('autoBingo')} />
                            ) : <span className="locked-opt">🔒</span>}
                        </div>
                        {!player.isPremium && <p className="upsell-txt">{t('premOnly')}</p>}
                        <button className="big-button" onClick={toggleSettings}>{t('save')}</button>
                    </div>
                </div>
            )}

            {errorMsg && <div className="error-bar">{errorMsg}</div>}
            <main>
                {gameState.status === 'idle' && (
                    <div className="idle-screen"><h2>{t('waiting')}</h2><div className="pulse-dot"></div><p className="hint">{!audioEnabled ? t('hintOff') : t('hintOn')}</p></div>
                )}
                {gameState.status === 'finished' && <div className="winner">🎉 {t('winner')}: {gameState.winner} {t('won')} {gameState.pot} ! 🎉</div>}

                {(gameState.status === 'pending' || gameState.status === 'active') && (
                    <div className="game-status-bar">
                        <PatternDisplay pattern={gameState.pattern} t={t} />
                        <div className="prize-box">
                            <span className="lbl">{t('gameId')} {gameState.displayId || gameState.gameId}</span>
                            <span className="val">{t('prizeLabel')} {displayPrize}{t('currency')}</span>
                        </div>
                    </div>
                )}

                {gameState.status === 'pending' && (
                    <div className="joining">
                        <div className="timer-display">
                            {countdown > 0 ? (
                                <div className="lobby-countdown">
                                    <span className="cnt-label">GAME STARTING IN</span>
                                    <span className="cnt-value">{Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}</span>
                                </div>
                            ) : t('hostMsg')}
                        </div>
                        <div className="bet-display">{t('bet')}: {gameState.betAmount}</div>

                        {myCards.length > 0 && (
                            <div className="my-selected-cards">
                                <h3>{t('myCards')} ({myCards.length}/{MAX_CARDS})</h3>
                                <div className="mini-cards-list">{myCards.map(c => <div key={c.id} className="mini-card">#{c.displayId}</div>)}</div>
                            </div>
                        )}
                        {myCards.length < MAX_CARDS ? (
                            cardOptions.length === 0 ? (
                                <button className="big-button" onClick={requestJoin}>{t('reqCards')}</button>
                            ) : (
                                <div className="selection-area">
                                    {!selectedOption ? (
                                        <>
                                            <div className="shuffle-container">
                                                <span>{t('pickCard')}</span>
                                                <div className="custom-card-input">
                                                    <input type="number" placeholder="#" value={customCardNum} onChange={(e) => setCustomCardNum(e.target.value)} />
                                                    <button onClick={getSpecificCard}>{t('customBtn')}</button>
                                                </div>
                                            </div>
                                            <div className="number-grid">
                                                {cardOptions.map(opt => {
                                                    const state = cardStates[opt.id] || { viewers: [], takenBy: null };
                                                    const isTaken = state.takenBy && state.takenBy !== auth.userId;
                                                    const isMine = state.takenBy === auth.userId;
                                                    const isBeingViewed = state.viewers.length > 0;

                                                    // LOCKED / TAKEN LOGIC
                                                    const isLocked = isTaken;

                                                    return (
                                                        <button
                                                            key={opt.id}
                                                            className={`num-btn ${isMine ? 'mine' : ''} ${isLocked ? 'locked' : ''} ${isBeingViewed ? 'viewing' : ''}`}
                                                            onClick={() => {
                                                                // Allow viewing if it's mine OR if it's available (not taken/viewed)
                                                                if (isMine) setSelectedOption(opt);
                                                                else if (!isLocked && !isBeingViewed) setSelectedOption(opt);
                                                            }}
                                                            disabled={isLocked && !isMine} // Disabled only if someone else took it
                                                        >
                                                            {isLocked ? "🔒" : (opt.label || `${opt.id}`)}
                                                            {isMine && <span className="view-badge">✔</span>}
                                                            {!isLocked && isBeingViewed && <span className="view-badge">{t('cardView')}</span>}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </>
                                    ) : (
                                        <div className="card-preview">
                                            <h3>{t('cardNo')} {selectedOption.label || selectedOption.id}</h3>
                                            <BingoCard cardData={selectedOption.grid} isPreview={true} />
                                            <div className="preview-actions">
                                                <button className="cancel-btn" onClick={() => setSelectedOption(null)}>{t('back')}</button>
                                                <button
                                                    className="confirm-btn"
                                                    onClick={confirmCard}
                                                    disabled={isConfirming}
                                                >
                                                    {isConfirming ? "Processing..." : t('confirm')}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )
                        ) : <h3>{t('maxCards')}</h3>}
                    </div>
                )}

                {gameState.status === 'active' && (
                    <div className="active-game">
                        <header className="game-header">
                            <div className="called-nums">
                                <div className="last-called-num">
                                    <span className="label">{t('lastCalled')}</span>
                                    <div className="ball">{formatBingoNum(gameState.calledNumbers[gameState.calledNumbers.length - 1])}</div>
                                </div>
                                <div className="called-history">
                                    <div className="called-history-list">
                                        {gameState.calledNumbers.slice().reverse().map((n, i) => (
                                            <span key={i} className="mini-ball">{formatBingoNum(n)}</span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </header>
                        {myCards.length > 0 ? (
                            <div className="my-cards-container">
                                {myCards.map(card => (
                                    <div key={card.id} className="player-card-wrapper">
                                        <div className="card-title">{t('cardNo')} {card.displayId}</div>
                                        <BingoCard cardData={card.card_data} markedCells={markedCells[card.id] || new Set()} onCellClick={(num) => toggleMark(num, card.id)} />
                                        <button className="bingo-btn" onClick={() => claimBingo(card.id)} disabled={checkingCardId === card.id}>{checkingCardId === card.id ? t('checking') : t('bingo')}</button>
                                    </div>
                                ))}
                            </div>
                        ) : <h3> {t('watching')} </h3>}
                    </div>
                )}
            </main>
        </div>
    );
}

// Wrap App with Error Boundary
const AppWithErrorBoundary = () => (
    <ErrorBoundary>
        <App />
    </ErrorBoundary>
);

export default AppWithErrorBoundary;