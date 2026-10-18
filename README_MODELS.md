# README_MODELS.md — Modelli Predittivi, Regole Incrociate e Strato Coach

Questo documento descrive l'architettura matematica, le fonti scientifiche, i parametri, i limiti fisiologici e le procedure di taratura dei due modelli predittivi deterministici e del motore di regole integrati nella PWA **KOVA.**

---

## 1. Architettura & Principi Non Negoziabili

1. **Separazione calcolo / interpretazione**: Tutti i numeri (peso di tendenza, TDEE reale, bande di confidenza, previsioni a 4/8/12 settimane, CTL/ATL/TSB, ACWR, e1RM, pendenze Theil-Sen, serie per gruppo muscolare e insight di allerta) sono calcolati da moduli deterministici puri (`js/energy-model.js`, `js/training-model.js`, `js/coach-rules.js`). L'LLM (`Gemini Flash` in `js/gemini.js`) riceve esclusivamente un payload JSON sintetico (< 2k token) e si limita a interpretarlo in italiano senza inventare numeri.
2. **Funzionamento Offline-First**: I modelli girano interamente lato client nel browser e salvano snapshot e parametri sia in `localStorage` sia su Firestore (`model_daily_snapshots`, `model_params`, `insights`, `coach_reports`). Se la rete o Gemini non rispondono, `buildDeterministicCoachFallback()` genera in modo sincrono lo stesso identico schema JSON del Coach.
3. **Degradazione elegante (Cold-Start)**: Sotto i 14 giorni di dati di peso e diario alimentare, il Modello 1 opera in modalità preliminare usando il prior di Mifflin-St Jeor (o media Mifflin + Katch-McArdle se è nota la %BF) e mostra esplicitamente all'utente quanti giorni di raccolta mancano per la piena convergenza.

---

## 2. Modello 1: "Adaptive Energy Balance & Weight Forecast" ([`js/energy-model.js`](file:///Users/epanico001/Desktop/Dev/fitness-tracker-app/js/energy-model.js))

### 2.1 Fonti Scientifiche
- **Hall KD et al.**, *"Quantification of the effect of energy imbalance on bodyweight"*, **The Lancet**, 378(9793):826–837, 2011 (NIH Body Weight Planner).
- **Hall KD**, *"What is the required energy deficit per unit weight loss?"*, **Int J Obes**, 32(3):573–576, 2008.
- **Camacho-García-Formentí D, Zepeda-Tello R**, pacchetto R **`bw`** (CRAN): *Dynamic Body Weight Models for Children and Adults*.
- **Walker J**, *"The Hacker's Diet"*, 1991 (media mobile esponenziale del peso con $\alpha = 0.1$).
- **Trexler E, Nuckols G**, *MacroFactor / Stronger By Science Adaptive Expenditure* (stima adattiva del dispendio energetico da serie storiche di peso e intake).
- **Mifflin MD, St Jeor ST et al.**, **Am J Clin Nutr**, 51(2):241–247, 1990 (BMR a priori).
- **Helms ER et al.**, **JISSN**, 11:20, 2014 (velocità di perdita consigliata $0.5\text{–}1.0\%$ del peso corporeo a settimana in definizione).
- **Morton RW et al.**, **Br J Sports Med**, 52(6):376–384, 2018 (apporto proteico $1.6\text{–}2.2\text{ g/kg/giorno}$).

### 2.2 Formulazione Matematica

#### Stato e Transizione (Filtro di Kalman a 2 stati)
Il vettore di stato giornaliero è:
$$\mathbf{x}_t = \begin{bmatrix} w_t \\ \text{TDEE}_t \end{bmatrix}$$
dove $w_t$ è il peso corporeo vero (depurato dalle fluttuazioni rapide di acqua/glicogeno/contenuto intestinale) e $\text{TDEE}_t$ è il dispendio energetico totale giornaliero reale.

Nei giorni con diario alimentare registrato ($u_t = \text{intake\_kcal}_t$):
$$\begin{aligned}
w_{t|t-1} &= w_{t-1} + \frac{u_t - \text{TDEE}_{t-1}}{\rho} \\
\text{TDEE}_{t|t-1} &= \text{TDEE}_{t-1}
\end{aligned} \qquad
\mathbf{F} = \begin{bmatrix} 1 & -1/\rho \\ 0 & 1 \end{bmatrix}$$
dove $\rho \approx 7700\text{ kcal/kg}$ (parametro configurabile; come dimostrato in Hall 2008, la densità energetica effettiva dipende dalla composizione del tessuto perso/acquisito e dalla durata della restrizione).

#### Equazione di Osservazione e Gating Robusto degli Outlier
Quando è disponibile la pesata mattutina $z_t$:
$$z_t = \mathbf{H} \mathbf{x}_t + \varepsilon_t, \qquad \mathbf{H} = \begin{bmatrix} 1 & 0 \end{bmatrix}, \quad \varepsilon_t \sim \mathcal{N}(0, \sigma_z^2)$$
Se l'innovazione $|y_t| = |z_t - w_{t|t-1}| > 2.5\text{ kg}$ (es. ritenzione idrica acuta post-ricarica di carboidrati/sodio), il filtro attiva un gating robusto di tipo Huber gonfiando la varianza osservazionale $R_{\text{eff}} = \sigma_z^2 \cdot (|y_t| / 1.2)^2$ e segnalando `outlier = true`.

#### Controllo Incrociato su Finestra Mobile (14–28 giorni) e Fusione Bayesiana
In parallelo al filtro di Kalman viene calcolata la media mobile esponenziale di *Hacker's Diet* ($\text{EMA}_t = \text{EMA}_{t-1} + 0.1 (z_t - \text{EMA}_{t-1})$) e lo stimatore algebrico su finestra mobile di $L \in [14, 21]$ giorni tramite regressione lineare ordinaria (OLS) della pendenza del peso $\hat{\beta}_{\text{OLS}}$ (kg/giorno):
$$\widehat{\text{TDEE}}_{\text{win}} = \bar{u}_{L} - \rho \cdot \hat{\beta}_{\text{OLS}}, \qquad \text{Var}(\widehat{\text{TDEE}}_{\text{win}}) = \frac{12 \rho^2 \sigma_{\text{res}}^2}{L(L^2 - 1)}$$
Lo stato finale $\text{TDEE}_t$ viene fuso a varianza inversa con $\widehat{\text{TDEE}}_{\text{win}}$, garantendo convergenza entro $\pm 100\text{ kcal}$ dal TDEE vero in $\le 21$ giorni.

#### Previsione con Adattamento Metabolico Dinamico (Hall Lancet 2011)
La simulazione a 4, 8 e 12 settimane integra l'equazione differenziale linearizzata del modello di Hall:
$$\frac{dw}{dt} = \frac{I_{\text{plan}} - \text{TDEE}_0 - \varepsilon \cdot (w(t) - w_0)}{\rho}$$
dove $\varepsilon \approx 22\text{ kcal/giorno/kg}$ rappresenta l'adattamento metabolico al calare della massa corporea.

### 2.3 Parametri e Taratura (`ENERGY_MODEL_DEFAULTS`)
| Parametro | Default | Significato e Come Tararlo |
|---|---|---|
| `rhoKcalPerKg` | `7700` | Densità energetica per kg di variazione peso. Abbassare a `7000–7200` nelle prime 2 settimane di cut se il soggetto perde molta massa magra/glicogeno. |
| `obsWeightSigmaKg` | `0.45` | Rumore giornaliero della bilancia + acqua corporea (kg). Alzare a `0.65–0.80` se l'utente si pesa ad orari variabili. |
| `processTdeeSigmaKcal` | `45` | Rumore di processo giornaliero sul TDEE (kcal). Alzare a `60` se il NEAT (passi) varia drasticamente di settimana in settimana. |
| `hallAdaptationKcalPerKg` | `22` | Coefficiente $\varepsilon$ di Hall (kcal/gg per kg perso). |
| `minSafeKcalMale` / `Female` | `1500` / `1200` | Soglia minima clinica mai violata dalle raccomandazioni (`max(BMR, soglia)`). |

---

## 3. Modello 2: "Fitness-Fatigue + Strength Progression" ([`js/training-model.js`](file:///Users/epanico001/Desktop/Dev/fitness-tracker-app/js/training-model.js))

### 3.1 Fonti Scientifiche
- **Banister EW et al.**, **Aust J Sports Med**, 7:57–61, 1975 (modello impulse-response Fitness-Fatigue).
- **Busso T**, **Med Sci Sports Exerc**, 35(7):1188–1195, 2003 (calibrazione vincolata dei parametri).
- **Coggan AR / TrainingPeaks**, *Performance Management Chart (PMC)* ($\tau_1 = 42\text{ gg}$, $\tau_2 = 7\text{ gg}$).
- **Foster C et al.**, **J Strength Cond Res**, 15(1):109–115, 2001 ($\text{sRPE} = \text{RPE}_{\text{CR10}} \times \text{minuti}$).
- **Williams S et al.**, **Br J Sports Med**, 51(3):209–210, 2017 (ACWR con medie esponenziali EWMA 7/28 giorni).
- **Epley B** (1985) & **Zourdos MC, Helms ER et al.**, **J Strength Cond Res**, 30(1):267–275, 2016 (scala RPE/RIR).
- **Theil H** (1950) & **Sen PK** (1968), **J Am Stat Assoc** (regressione robusta mediana).
- **Schoenfeld BJ et al.**, **J Sports Sci**, 35(11):1073–1082, 2017 (dose-risposta volume settimanale per muscolo).

### 3.2 Formulazione Matematica

1. **Carico di Sessione ($w_t$)**:
   - Priorità 1: $\text{sRPE} = \text{RPE}_{\text{sessione}} \times \text{durata\_minuti}$ (Foster 2001).
   - Priorità 2: $\text{serie\_impegnative (RIR} \le 3) \times 18$.
   - Priorità 3: $\text{tonnellaggio\_kg} / 25$.
2. **PMC / Banister**:
   $$\text{CTL}_t = \text{CTL}_{t-1} e^{-1/\tau_1} + w_t (1 - e^{-1/\tau_1}), \quad \text{ATL}_t = \text{ATL}_{t-1} e^{-1/\tau_2} + w_t (1 - e^{-1/\tau_2}), \quad \text{TSB}_t = \text{CTL}_t - \text{ATL}_t$$
   con $\tau_1 = 42\text{ gg}$, $\tau_2 = 7\text{ gg}$. Dopo $\ge 8$ settimane di allenamenti, i pesi $k_1, k_2$ di $p(t) = p_0 + k_1 \text{CTL}_t - k_2 \text{ATL}_t$ vengono calibrati con minimi quadrati vincolati ($k_2 \ge k_1 \ge 0.02$) e regolarizzazione $L_2$ (Tikhonov, $\lambda = 5.0$) sull'indice composito degli e1RM dei fondamentali.
3. **ACWR (EWMA 7/28)**:
   $$\text{EWMA}_{\text{acuto}, t} = \lambda_a w_t + (1 - \lambda_a)\text{EWMA}_{\text{acuto}, t-1} \quad (\lambda_a = 2/8), \qquad \text{ACWR}_t = \frac{\text{EWMA}_{\text{acuto}, t}}{\text{EWMA}_{\text{cronico}, t}}$$
   *Nota metodologica*: l'ACWR è esposto con avviso esplicito che si tratta di un indicatore descrittivo discusso in letteratura (Impellizzeri et al. 2020), non di una diagnosi medica.
4. **e1RM e Tendenza Theil-Sen**:
   $$\text{e1RM} = \text{carico} \times \left(1 + \frac{\text{reps} + \text{RIR}}{30}\right)$$
   La pendenza $\hat{m} = \text{median}_{i < j} \frac{y_j - y_i}{t_j - t_i}$ classifica ogni esercizio in `progress`, `plateau` ($|\text{slope}| \le 0.25\%/\text{sett}$ per $\ge 3$ settimane) o `regress` ($< -0.5\%/\text{sett}$).

---

## 4. Motore di Regole Incrociate ([`js/coach-rules.js`](file:///Users/epanico001/Desktop/Dev/fitness-tracker-app/js/coach-rules.js))

Otto regole deterministiche testate singolarmente in `test-models.js`:
1. `rapid_weight_loss`: Perdita $> 1.0\%/\text{settimana}$ per 2 settimane in definizione $\rightarrow$ alza le kcal.
2. `low_protein_intake`: Proteine medie 7gg $< 1.6\text{ g/kg}$ $\rightarrow$ aumenta apporto proteico verso $1.8\text{–}2.0\text{ g/kg}$.
3. `deficit_fatigue_strength_drop`: Deficit attivo + calo e1RM su $\ge 2$ esercizi + $\text{TSB} \le -15$ $\rightarrow$ propone deload o diet break a mantenimento.
4. `weight_plateau_adaptive_tdee`: Stallo del `trendWeight` per $\ge 21$ giorni con aderenza $\ge 80\%$ $\rightarrow$ ricalibra le kcal sul TDEE adattivo.
5. `high_acwr_spike`: ACWR EWMA $> 1.5$ $\rightarrow$ riduci il volume della settimana successiva del 20–25%.
6. `low_diary_adherence`: Aderenza $< 70\%$ negli ultimi 14gg $\rightarrow$ segnala allargamento dell'intervallo di confidenza del TDEE.
7. `strength_plateau_detected`: Stallo dell'e1RM su esercizi chiave $\rightarrow$ suggerisce doppia progressione o rotazione variante.
8. `insufficient_sleep_recovery`: Media sonno 7gg $< 6.0$ ore $\rightarrow$ tutela il recupero riducendo il cedimento (RIR 0).

---

## 5. Esecuzione dei Test Automatici

```bash
node test-pipeline.js
node test-models.js
```
