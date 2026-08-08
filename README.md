# 🕵️‍♂️ MAFIA - The Online Party Game

A real-time, multiplayer web version of the classic social deduction game **Mafia**. Built with Node.js, Socket.io, and Tailwind CSS, this game features an "Among Us" style lobby system, a global server browser, and a highly advanced backend "God Engine" that handles complex, simultaneous night actions.

## ✨ Features

*   **Among Us Style UI:** Seamlessly Create (Host), Find (Public Servers), or Join (Private Codes) games.
*   **Global & Local Servers:** Play with friends using a secret 6-letter room code, or open your lobby to the world via the Server Browser.
*   **Smart Reconnect:** Accidental page refresh? No problem. Browser `sessionStorage` remembers your session and drops you right back into the game without logging out.
*   **Real-time Chat & Voting:** Discuss suspicions during the Day phase and cast votes in real-time.
*   **Advanced "God Engine":** The backend handles massive, multi-role crossfires automatically. 

---

## ⚖️ Dynamic Role Scaling

To keep games perfectly balanced regardless of lobby size, the server automatically scales the number of special roles based on the total number of players ($N$).

*   **The 6-Player Rule (Doctors & Police):** The game starts with 1 Doctor and 1 Police officer. For every 6 players in the game (i.e., $k = \lfloor N/6 \rfloor$), the game adds $+k$ Doctors and $+k$ Police to the town. *(Example: A 12-player game will have 3 Doctors and 3 Police).*
*   **The 9-Player Rule (Sex Workers):** The game starts with 1 Sex Worker. If there are more than 9 players in the lobby, the Sex Worker count is increased to 2.
*   **The Mafia:** The game will always spawn exactly 1 Mafia member, regardless of the total lobby size.

---

## 🎭 Roles

*   🔪 **Mafia:** Work together secretly at night to eliminate the townspeople. Blend in during the day.
*   🛡️ **Doctor:** Choose one person to protect each night. You can protect yourself, but choose wisely!
*   🚓 **Police:** Investigate one player every night to uncover if they are suspicious.
*   💋 **Sex Worker:** Visit a player at night. High risk, high reward. Causes complex crossfire mechanics.
*   🧑‍🌾 **Villager:** You have no special night powers. Use your voice, logic, and voting power during the day to find and execute the Mafia.

---

## ⚔️ Night Phase Mechanics & Eliminations

The "God Engine" processes all night actions simultaneously. Because there can be multiple Doctors, Mafias, and Sex Workers, eliminations and protections follow a strict set of logical rules:

### Core Rules
1.  **Direct Kill:** The Mafia targets a player. That player dies unless protected.
2.  **Direct Protection:** The Doctor targets a player. That player survives a direct Mafia attack.
3.  **The Assassin's Embrace:** If a Sex Worker visits a Mafia member, that specific Mafia member is "distracted" and their kill for the night is completely blocked.
4.  **Collateral Damage (Targeting the SW):** If the Mafia directly targets a Sex Worker, the Sex Worker dies. **However**, the person the Sex Worker was visiting *also* dies in the crossfire (unless that person is Mafia or protected).
5.  **Wrong Place, Wrong Time:** If a Sex Worker visits a player, and the Mafia attacks that player, **both** the target and the Sex Worker are killed.
6.  **The Deadly Triangle (Shield-Piercing):** If a Doctor protects a player who dies via Sex Worker collateral damage, the Doctor is dragged into the crossfire and killed as well!

---

### 💥 High-Volume Edge Cases & Chain Reactions

Because of simultaneous action calculations and dynamic role scaling, complex edge cases can trigger massive single-night bloodbaths:

*   **The Double Shield Collapse (4+ Kills, 1 Bullet):**
    If Doctor A and Doctor B both protect Target X, Sex Worker visits Target X, and Mafia shoots the Sex Worker — the collateral explosion pierces Target X's shield and travels up **both** Doctors' protection beams simultaneously. Target X, the Sex Worker, Doctor A, and Doctor B are all eliminated.

*   **The Twin Escort Blast (5+ Kills):**
    In games with 10+ players (where 2 Sex Workers spawn), if Sex Worker 1 and Sex Worker 2 both visit Target X while protected by separate Doctors, a Mafia strike on Target X triggers dual collateral reactions. Target X, both Sex Workers, and both Doctors are killed in the blast.

*   **The Broken Chain (Physical Proximity Logic):**
    If Doctor A protects Person A, Doctor B protects Doctor A, Sex Worker visits Doctor B, and Mafia shoots the Sex Worker — only Doctor B and the Sex Worker die. Doctor A and Person A survive because Doctor A is physically at Person A's house, stopping the collateral explosion from traveling further down the line.

*   **Independent Guns (Multi-Mafia Volleys):**
    In multi-Mafia games, each Mafia operates independently. If multiple Mafias target separate individuals, each attack executes its own collateral and protection checks, allowing up to 6 or 7 players to fall in a single night phase.

