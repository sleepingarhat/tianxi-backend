      var t1 = race.top1Hit ? '<span class="pill success">命中</span>' : '<span class="pill failure">未中</span>';
        var t3i = race.top3IntersectCount;
        var t3rcls = t3i >= 2 ? 'ok' : t3i === 0 ? 'bad' : '';
        var dot = function(hit) { return hit ? '<span class="ok" style="font-weight:700">●</span>' : '<span class="muted-cell">○</span>'; };
        return '<tr>'
          + '<td><strong>' + race.raceNumber + '</strong></td>'
          + '<td class="muted-cell" style="font-size:11px">' + (race.distance ? race.distance + 'm' : '') + (race.going ? ' / ' + race.going : '') + '</td>'
          + '<td>' + predHtml + '</td>'
          + '<td>' + actHtml + '</td>'
          + '<td>' + t1 + '</td>'
          + '<td style="text-align:center">' + dot(race.quinellaHit) + '</td>'
          + '<td style="text-align:center">' + dot(race.trioHit) + '</td>'
          + '<td style="text-align:center">' + dot(race.tierceHit) + '</td>'
          + '<td class="' + t3rcls + '" style="text-align:center;font-weight:600">' + t3i + '/3</td>'
          + '</tr>';
      }).join('');
      // No client-side auto-load chain; SSR already has the numbers.
    }

    function renderMeetingRow(i) {
      if (!window._meetingList) return;
      renderMeetings();
    }

    // Legacy shim: older inline onclick may still call this — route through runHitReport
    function autoLoadHitForMeeting(i) {
      runHitReport(i);
    }

      async function loadHitRateRollup() {
    const days = (document.getElementById('rollupDays') || {}).value || '30';
    const stat = document.getElementById('rollupStatus');
    const body = document.getElementById('rollupContent');
    if (!stat || !body) return;
    stat.textContent = '運算中…（首次需評估每場）';
    body.innerHTML = '';
    try {
      const r = await fetch('/api/analyze/hit-rate-rollup?days=' + days);
      const d = await r.json();
      if (d.error) { stat.innerHTML = '<span class="bad">錯誤：' + d.error + '</span>'; return; }
      stat.innerHTML = '<span class="muted-cell">' + d.from + ' → ' + d.to + ' · ' + d.meetingsEvaluated + ' 場日 · ' + d.racesEvaluated + ' 場已評</span>';
      const t1cls = d.top1HitRate != null && d.top1HitRate >= 25 ? 'ok' : d.top1HitRate != null && d.top1HitRate < 12 ? 'bad' : '';
      const t3cls = d.top3AnyHitRate != null && d.top3AnyHitRate >= 70 ? 'ok' : d.top3AnyHitRate != null && d.top3AnyHitRate < 50 ? 'bad' : '';
      const fmtPct = (v) => v != null ? v.toFixed(1) + '%' : '—';
      // Compact metric tile builder — value + denom + colour-coded thresholds
        const tile = (label, val, n, denom, hi, lo) => {
          const cls = val == null ? '' : val >= hi ? 'ok' : val < lo ? 'bad' : '';
          return '<div><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px">' + label + '</div>'
            + '<div class="' + cls + '" style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums">' + fmtPct(val) + '</div>'
            + '<div style="font-size:10px;color:var(--mut)">' + (n != null ? n : '—') + ' / ' + (denom != null ? denom : '—') + '</div></div>';
        };
        body.innerHTML =
          '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">'
          + tile('Top 1 (獨贏)', d.top1HitRate, d.top1Hits, d.racesEvaluated, 25, 12)
          + tile('Top 3 任一', d.top3AnyHitRate, d.top3AnyHits, d.racesEvaluated, 70, 50)
          + tile('Quinella (Q)', d.quinellaHitRate, d.quinellaHits, d.racesEvaluated, 8, 3)
          + tile('Quinella Place', d.qpHitRate, d.qpHits, d.racesEvaluated, 25, 10)
          + tile('Trio 三重彩', d.trioHitRate, d.trioHits, d.racesEvaluated, 5, 1)
          + tile('Tierce 3T', d.tierceHitRate, d.tierceHits, d.racesEvaluated, 1.5, 0.3)
          + tile('First 4', d.first4HitRate, d.first4Hits, d.first4Eligible, 1, 0.2)
          + '<div><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px">Top 3 平均交集</div>'
            + '<div style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums">' + (d.top3AvgIntersect != null ? d.top3AvgIntersect.toFixed(2) : '—') + '<span style="font-size:12px;color:var(--mut)"> / 3</span></div></div>'
        + (d.perMeeting && d.perMeeting.length ? '<div style="margin-left:auto;flex:1;min-width:280px"><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">逐場日 (Top1% / Top3任一%)</div>'
          + '<div style="display:flex;gap:3px;flex-wrap:wrap;font-variant-numeric:tabular-nums">'
          + d.perMeeting.slice().reverse().map(m => {
              const cls = m.top1HitRate >= 25 ? 'ok' : m.top1HitRate < 12 ? 'bad' : '';
              return '<span title="' + m.date + ' ' + m.venue + ' · Top1 ' + (m.top1HitRate != null ? m.top1HitRate.toFixed(1) : '—') + '% · Top3 ' + (m.top3AnyHitRate != null ? m.top3AnyHitRate.toFixed(1) : '—') + '%" style="font-size:10px;padding:1px 5px;border:1px solid var(--rule);border-radius:3px" class="' + cls + '">' + m.date.substring(5) + ' ' + (m.top1HitRate != null ? m.top1HitRate.toFixed(0) : '—') + '/' + (m.top3AnyHitRate != null ? m.top3AnyHitRate.toFixed(0) : '—') + '</span>';
            }).join('')
          + '</div></div>' : '')
        + '</div>';
    } catch (e) {
      stat.innerHTML = '<span class="bad">錯誤：' + e.message + '</span>';
    }
  }


  // ── 賽事日預測 / 比對報告 ──────────────────────────────────────────
  async function runPicksForDate(i) {
    const m = window._meetingList && window._meetingList[i];
    if (!m) return;
    const panel = document.getElementById('meetingPanel');
    panel.innerHTML = '<div style="padding:10px;color:var(--mut);font-size:12px">運算 ' + m.date + ' 預測中（每場約 5-10 秒）…</div>';
    try {
      const res = await fetch('/api/analyze/picks-by-date?date=' + encodeURIComponent(m.date));
      const data = await res.json();
      if (data.error) { panel.innerHTML = '<div style="padding:10px;color:var(--red)">錯誤：' + data.error + '</div>'; return; }
      renderMeetingPicksPanel(panel, data, m);
    } catch (e) {
      panel.innerHTML = '<div style="padding:10px;color:var(--red)">錯誤：' + e.message + '</div>';
    }
  }

  async function runHitReport(i) {
    const m = window._meetingList && window._meetingList[i];
    if (!m) return;
    const panel = document.getElementById('meetingPanel');
    panel.innerHTML = '<div style="padding:10px;color:var(--mut);font-size:12px">運算 ' + m.date + ' 比對報告中…</div>';
    window._meetingHits[m.date] = 'loading';
    renderMeetings();
    try {
      const res = await fetch('/api/analyze/hit-rate?date=' + encodeURIComponent(m.date));
      const data = await res.json();
      if (data.error) {
        panel.innerHTML = '<div style="padding:10px;color:var(--red)">錯誤：' + data.error + '</div>';
        return;
      }
      window._meetingHits[m.date] = data;
      renderMeetings();
      renderHitReportPanel(panel, data, m);
    } catch (e) {
      panel.innerHTML = '<div style="padding:10px;color:var(--red)">錯誤：' + e.message + '</div>';

    }
  }

  function renderMeetingPicksPanel(el, data, m) {
    var venueLabel = m.venue === 'ST' ? '沙田' : m.venue === 'HV' ? '跑馬地' : m.venue;
    var srcTag = data.source === 'historical' ? '<span class="pill queued">歷史重算</span>' : '<span class="pill success">即時排位</span>';
    var engineTag = data.eloEngine === 'v12' ? 'v1.2' : (data.eloEngine || '—');
    var fmtElo = function(v) { return v != null ? '<span class="tp-elo">' + Math.round(v) + '</span>' : '<span class="muted-cell">—</span>'; };
    var fmtPct = function(v) { return v != null ? (v*100).toFixed(1) + '%' : '—'; };
    var fmtBonus = function(v) { if (v == null) return '—'; var c = v > 0 ? 'tp-bonus-pos' : v < 0 ? 'tp-bonus-neg' : ''; return '<span class="' + c + '">' + (v >= 0 ? '+' : '') + v + '</span>'; };
    var raceBlocks = (data.races || []).map(function(race, ri) {
      var picks = race.picks || [];
      var topHorse = picks[0] ? '<strong>' + (picks[0].nameCh || picks[0].nameEn || '—') + '</strong> ' + fmtPct(picks[0].pWin) : '無資料';
      var rows = picks.map(function(p) {
        var rc = p.rank === 1 ? 'tp-rank-1' : p.rank <= 3 ? 'tp-rank-2' : '';
        return '<tr>'
          + '<td class="' + rc + '">' + p.rank + '</td>'
          + '<td>' + (p.horseNumber || '—') + '</td>'
          + '<td><div class="tp-hname">' + (p.nameCh || p.nameEn || '—') + '</div><div class="tp-sub">' + (p.jockeyCh || '—') + ' / ' + (p.trainerCh || '—') + '</div></td>'
          + '<td style="text-align:center">' + (p.draw != null ? p.draw : '—') + '</td>'
          + '<td>' + fmtElo(p.horseElo) + '</td>'
          + '<td>' + fmtElo(p.jockeyElo) + '</td>'
          + '<td>' + fmtElo(p.trainerElo) + '</td>'
          + '<td><strong>' + fmtElo(p.eloComposite) + '</strong></td>'
          + '<td>' + fmtBonus(p.factorBonus) + '</td>'
          + '<td><strong>' + fmtElo(p.finalScore) + '</strong></td>'
          + '<td class="' + (p.rank === 1 ? 'ok' : '') + '">' + fmtPct(p.pWin) + '</td>'
          + '<td>' + fmtPct(p.pTop3) + '</td>'
          + '</tr>';
      }).join('');
      var isOpen = ri < 2 ? ' open' : '';
      return '<div class="tp-race' + isOpen + '" id="mp-r' + race.raceNumber + '">'
        + '<div class="tp-race-hd" onclick="document.getElementById(&quot;mp-r' + race.raceNumber + '&quot;).classList.toggle(&quot;open&quot;)">'
          + '<div class="tp-rnum">' + race.raceNumber + '</div>'
          + '<div class="tp-race-meta"><div class="tp-race-title">' + (race.title || '第' + race.raceNumber + '場') + '</div>'
            + '<div class="tp-race-sub">' + (race.distance ? race.distance + 'm' : '') + (race.going ? ' · ' + race.going : '') + (race.class ? ' · ' + race.class : '') + ' · ' + picks.length + ' 匹</div></div>'
          + '<div style="margin-left:auto;font-size:12px;color:var(--mut);white-space:nowrap">' + topHorse + '</div>'
          + '<span class="tp-chevron">▶</span></div>'
        + '<div class="tp-table-wrap"><table class="tp-table"><thead><tr>'
          + '<th>排名</th><th>馬號</th><th>馬名 / 騎師 / 練馬師</th><th>檔</th>'
          + '<th>馬ELO</th><th>騎ELO</th><th>練ELO</th><th>綜合ELO</th>'
          + '<th>因子</th><th>最終分</th><th>勝率</th><th>前三</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }).join('');
    var fmtP = function(v) { return v != null ? v.toFixed(1) + '%' : '—'; };
      var pool = function(label, n, d) { return '<span style="margin-right:14px;white-space:nowrap"><span style="color:var(--mut);font-size:11px">' + label + '</span> <strong style="font-variant-numeric:tabular-nums">' + fmtP(d) + '</strong> <span class="muted-cell" style="font-size:11px">(' + (n != null ? n : 0) + ')</span></span>'; };
      el.innerHTML = '<div style="padding:10px 12px;background:#fff;border:1px solid var(--rule);border-radius:4px;margin-bottom:8px;font-size:12px">'
        + '<strong>' + data.date + ' 比對報告</strong> · ' + venueLabel + ' · ' + s.racesEvaluated + ' 場已評 · '
        + 'Top1 <span class="' + t1cls + '" style="font-weight:600">' + (s.top1HitRate != null ? s.top1HitRate.toFixed(1) + '%' : '—') + '</span> (' + s.top1Hits + '/' + s.racesEvaluated + ') · '
        + 'Top3任一 <span class="' + t3cls + '" style="font-weight:600">' + (s.top3AnyHitRate != null ? s.top3AnyHitRate.toFixed(1) + '%' : '—') + '</span> (' + s.top3AnyHits + '/' + s.racesEvaluated + ') · '
        + '平均交集 <strong>' + (s.top3AvgIntersect != null ? s.top3AvgIntersect.toFixed(2) : '—') + '/3</strong>'
        + ' <button class="ghost" style="float:right;font-size:11px;padding:2px 8px" onclick="document.getElementById(&quot;meetingPanel&quot;).innerHTML=&quot;&quot;">關閉</button>'
        + '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--rule);font-size:12px;line-height:1.7">'
          + '<span style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-right:10px">HK 彩池命中率</span>'
          + pool('Quinella', s.quinellaHits, s.quinellaHitRate)
          + pool('Q.Place', s.qpHits, s.qpHitRate)
          + pool('Trio', s.trioHits, s.trioHitRate)
          + pool('Tierce 3T', s.tierceHits, s.tierceHitRate)
          + pool('First 4', s.first4Hits, s.first4HitRate)
        + '</div>'
        + '</div>'
        + '<table style="margin-top:6px"><thead><tr>'
        + '<th>場</th><th>賽事</th><th>預測前三 (含三軸 ELO)</th><th>實際前三</th><th>Top1</th><th title="Quinella: 預測 top2 = 實際 top2 任順序">Q</th><th title="Trio: 預測 top3 = 實際 top3 任順序">Trio</th><th title="Tierce: 預測 top3 = 實際 top3 完全順序">3T</th><th>Top3 交集</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

    function renderNextRaceDay() {
        var nd = D.nextRaceDay;
        var labelEl = document.getElementById('nrdLabel');
        var racesEl = document.getElementById('nrdRaces');
        var horsesEl = document.getElementById('nrdHorses');
        if (!racesEl) return;
        if (!nd) {
          if (labelEl) labelEl.textContent = '';
          racesEl.innerHTML = '<p style="color:var(--mut);font-size:13px">暫無即日賽事資料</p>';
          if (horsesEl) horsesEl.innerHTML = '';
          return;
        }
        var venueLabel = nd.venue === 'ST' ? '沙田' : nd.venue === 'HV' ? '跑馬地' : (nd.venue || '');
        if (labelEl) labelEl.textContent = nd.date + ' · ' + venueLabel + (nd.trackCondition ? ' · ' + nd.trackCondition : '') + (nd.isUpcoming ? ' · 待賽' : ' · 已賽');

        function fmtForm(arr) {
          if (!arr || !arr.length) return '<span class="pmut">—</span>';
          return arr.map(function(p) {
            if (p === 999 || p === null) return '<span class="pdnf">U</span>';
            if (p === 1) return '<span class="p1">1</span>';
            if (p === 2) return '<span class="p2">2</span>';
            if (p === 3) return '<span class="p3">3</span>';
            return '<span class="pmut">' + p + '</span>';
          }).join('<span class="pmut">/</span>');
        }

        function fmtOdds(oddsObj, horseNum) {
          var o = oddsObj ? oddsObj[String(horseNum)] : null;
          if (o == null) return '<span class="nrd-odds-none">—</span>';
          var n = Number(o);
          var vals = Object.keys(oddsObj).map(function(k) { return Number(oddsObj[k]); }).filter(function(x) { return x > 0; });
          var minOdds = vals.length ? Math.min.apply(null, vals) : 999;
          if (n === minOdds && n < 10) return '<span class="nrd-odds-fav">' + n + '</span>';
          if (n < 5) return '<span class="nrd-odds-low">' + n + '</span>';
          return '<span class="nrd-odds-norm">' + n + '</span>';
        }

        function buildRaceHtml(r) {
          var parts = [];
          if (r.class) parts.push(r.class);
          if (r.distance) parts.push(r.distance + '米');
          var trackStr = [r.track, r.course].filter(Boolean).join(', ');
          if (trackStr) parts.push(trackStr);
          var subStr = parts.join(' · ');
          var timeStr = r.startTime ? r.startTime.substring(0, 5) : '';
          var entries = r.entries || [];
          var entriesHtml;
          if (entries.length > 0) {
            var rows = entries.map(function(e) {
              var name = e.name_ch || e.horse_code || '—';
              var jt = [e.jockey_name, e.trainer_name].filter(Boolean).join(' / ');
              var draw = e.draw != null ? e.draw : '—';
              var wt = e.declared_weight || e.actual_weight;
              var wtStr = wt != null ? wt : '—';
              var rating = e.rating || e.current_rating;
              var ratingStr = rating != null ? rating : '—';
              var badge = (e.priority_order && e.priority_order !== '正選') ? '<span class="nrd-badge rsv">' + e.priority_order + '</span>' : '';
              return '<tr>' +
                '<td style="color:var(--mut);font-size:11px">' + (e.horse_number || '—') + '</td>' +
                '<td><div class="nrd-hname">' + badge + name + '</div><div class="nrd-jt">' + (jt || '—') + '</div></td>' +
                '<td style="text-align:center">' + fmtOdds(r.odds, e.horse_number) + '</td>' +
                '<td style="text-align:center;color:var(--mut)">' + draw + '</td>' +
                '<td style="text-align:right;color:var(--mut)">' + wtStr + '</td>' +
                '<td style="text-align:right;color:var(--mut)">' + ratingStr + '</td>' +
                '<td><div class="nrd-form">' + fmtForm(e.recentForm) + '</div></td>' +
                '</tr>';
            }).join('');
            entriesHtml = '<div class="nrd-table-wrap"><table class="nrd-table"><thead><tr>' +
              '<th>馬號</th><th>馬名 / 騎師 / 練馬師</th><th>獨贏</th><th>檔</th>' +
              '<th style="text-align:right">負磅</th><th style="text-align:right">評分</th><th>近績</th>' +
              '</tr></thead><tbody>' + rows + '</tbody></table></div>';
          } else {
            entriesHtml = '<div class="nrd-table-wrap" style="padding:8px 14px;font-size:12px;color:var(--mut)">排位表資料暫未同步</div>';
          }
          return '<div class="nrd-race" id="nrd-r' + r.raceNumber + '">' +
            '<div class="nrd-race-hd" onclick="toggleNrdRace(' + r.raceNumber + ')">' +
            '<div class="nrd-rnum">' + r.raceNumber + '</div>' +
            '<div class="nrd-race-meta">' +
            '<div class="nrd-race-title">' + (r.title || '第' + r.raceNumber + '場') + '</div>' +
            '<div class="nrd-race-sub">' + subStr + '</div>' +
            '</div>' +
            '<span class="nrd-race-time">' + timeStr + '</span>' +
            '<span class="nrd-chevron">&#x203A;</span>' +
            '</div>' + entriesHtml + '</div>';
        }

        if (!nd.races || !nd.races.length) {
          racesEl.innerHTML = '<p style="color:var(--mut);font-size:13px">排位表資料暫未同步</p>';
        } else {
          racesEl.innerHTML = nd.races.map(buildRaceHtml).join('');
          var firstRace = nd.races[0];
          if (firstRace) {
            var firstEl = document.getElementById('nrd-r' + firstRace.raceNumber);
            if (firstEl) firstEl.classList.add('open');
          }
        }
        if (horsesEl) horsesEl.innerHTML = '';
      }

      function toggleNrdRace(raceNum) {
        var el = document.getElementById('nrd-r' + raceNum);
        if (el) el.classList.toggle('open');
      }
      function toggleTpRace(raceNum) {
        var el = document.getElementById('tp-r' + raceNum);
        if (el) el.classList.toggle('open');
      }

  
    // ── 即日全因子預測 ──
    async function runTodayPredictions() {
      var btn = document.getElementById('btnTodayPredict');
      var statusEl = document.getElementById('todayPredictStatus');
      var resultsEl = document.getElementById('todayPredictResults');
      btn.disabled = true;
      statusEl.textContent = '運算中，請稍候（每場約 5-10 秒）…';
      resultsEl.innerHTML = '';
      try {
        var res = await fetch('/api/analyze/today-picks');
        var data = await res.json();
        if (data.error) { statusEl.textContent = '錯誤：' + data.error; return; }
        var engTag = data.eloEngine === 'v12' ? 'v1.2' : (data.eloEngine || '—');
        statusEl.textContent = (data.date||'') + ' ' + (data.venue||'') + ' · '
          + data.races.length + ' 場 · ELO引擎 ' + engTag
          + (data.eloReady ? ' · ✓ ELO就緒' : ' · ⚠ ELO資料未就緒')
          + ' · 運算完成 ' + new Date().toLocaleTimeString('zh-HK');
        renderTodayPredictions(data);
      } catch (e) {
        statusEl.textContent = '錯誤：' + e.message;
      } finally {
        btn.disabled = false;
      }
    }

    function renderTodayPredictions(data) {
      var el = document.getElementById('todayPredictResults');
      if (!el) return;
      function fmtElo(v) { return v != null ? '<span class="tp-elo">' + Math.round(v) + '</span>' : '<span style="color:var(--mut)">—</span>'; }
      function fmtBonus(v, fb) {
        if (v == null) return '—';
        var cls = v > 0 ? 'tp-bonus-pos' : v < 0 ? 'tp-bonus-neg' : '';
        var s = '<span class="' + cls + '">' + (v >= 0 ? '+' : '') + v + '</span>';
        if (fb) {
          var lines = ['recency','distance','going','draw','weight','condition','injury','jtCombo'].map(function(k){
            var f = fb[k]; if (!f) return null;
            var col = f.bonus > 0 ? 'var(--green)' : f.bonus < 0 ? 'var(--red)' : 'var(--mut)';
            var sign = f.bonus >= 0 ? '+' : '';
            return '<span style="color:' + col + '">' + sign + f.bonus.toFixed(1) + '</span>'
                 + '<span style="color:var(--mut);font-size:10px"> ' + f.note + '</span>';
          }).filter(Boolean);
          if (lines.length) {
            s += '<details><summary style="font-size:10px;color:var(--mut);cursor:pointer">明細</summary>'
               + '<div class="tp-factor-detail">' + lines.join('<br>') + '</div></details>';
          }
        }
        return s;
      }
      function fmtPct(v) { return v != null ? (v*100).toFixed(1)+'%' : '—'; }
      el.innerHTML = (data.races || []).map(function(race, ri) {
        var picks = race.picks || [];
        var isOpen = ri < 3 ? ' open' : '';
        var topHorse = picks[0] ? ('<strong>' + (picks[0].nameCh || picks[0].nameEn || '—') + '</strong> ' + fmtPct(picks[0].pWin)) : '無資料';
        var rows = !picks.length
          ? '<tr><td colspan="12" style="padding:12px;color:var(--mut)">無排位資料</td></tr>'
          : picks.map(function(p) {
            var rc = p.rank===1 ? 'tp-rank-1' : p.rank<=3 ? 'tp-rank-2' : '';
            var probCls = 'tp-prob' + (p.rank===1 ? ' tp-prob-hi' : '');
            return '<tr>'
              + '<td class="' + rc + '">' + p.rank + '</td>'
              + '<td style="font-variant-numeric:tabular-nums">' + (p.horseNumber||'—') + '</td>'
              + '<td><div class="tp-hname">' + (p.nameCh||p.nameEn||'—') + '</div>'
                + '<div class="tp-sub">' + (p.jockeyCh||'—') + ' / ' + (p.trainerCh||'—') + '</div></td>'
              + '<td style="text-align:center">' + (p.draw!=null?p.draw:'—') + '</td>'
              + '<td>' + fmtElo(p.horseElo) + '</td>'
              + '<td>' + fmtElo(p.jockeyElo) + '</td>'
              + '<td>' + fmtElo(p.trainerElo) + '</td>'
              + '<td><strong>' + fmtElo(p.eloComposite) + '</strong></td>'
              + '<td>' + fmtBonus(p.factorBonus, p.factorBreakdown) + '</td>'
              + '<td><strong>' + fmtElo(p.finalScore) + '</strong></td>'
              + '<td class="' + probCls + (p.rank<=2?' ok':'') + '">' + fmtPct(p.pWin) + '</td>'
              + '<td>' + fmtPct(p.pTop3) + '</td>'
              + '</tr>';
          }).join('');
        return '<div class="tp-race' + isOpen + '" id="tp-r' + race.raceNumber + '">'
          + '<div class="tp-race-hd" onclick="toggleTpRace(' + race.raceNumber + ')">'
            + '<div class="tp-rnum">' + race.raceNumber + '</div>'
            + '<div class="tp-race-meta">'
              + '<div class="tp-race-title">' + (race.title||'第'+race.raceNumber+'場') + '</div>'
              + '<div class="tp-race-sub">'
                + (race.distance?race.distance+'m':'') + (race.going?' · '+race.going:'')
                + (race.class?' · '+race.class:'') + ' · ' + picks.length + ' 匹'
              + '</div>'
            + '</div>'
            + '<div style="margin-left:auto;font-size:12px;color:var(--mut);white-space:nowrap">' + topHorse + '</div>'
            + '<span class="tp-chevron">▶</span>'
          + '</div>'
          + '<div class="tp-table-wrap">'
            + '<table class="tp-table"><thead><tr>'
              + '<th>排名</th><th>馬號</th><th>馬名 / 騎師 / 練馬師</th><th>檔</th>'
              + '<th>馬ELO</th><th>騎ELO</th><th>練ELO</th><th>綜合ELO</th>'
              + '<th>因子調整</th><th>最終分</th><th>勝率</th><th>前三</th>'
            + '</tr></thead><tbody>' + rows + '</tbody></table>'
          + '</div>'
        + '</div>';
      }).join('');
    }

    // ── 初始化：直接渲染伺服器端數據，無需 fetch ──
  function safeRender(name, fn) {
    try { fn(); } catch (e) { console.error('[admin] ' + name + ' 渲染失敗:', e.message, e); }
  }
  safeRender('renderAlerts', renderAlerts);
  safeRender('renderCoverage', renderCoverage);
  safeRender('renderStatus', renderStatus);
  safeRender('renderRuns', renderRuns);
  safeRender('renderMeetings', renderMeetings);
  safeRender('loadHitRateRollup', loadHitRateRollup);
    safeRender('renderNextRaceDay', renderNextRaceDay);
  document.getElementById('refreshClock').textContent = '載入時間：' + new Date().toLocaleTimeString('zh-HK') + ' · 每 60 秒自動刷新';
  // Auto-reload page every 60s for fresh data — but skip while autoLoadHitChain is running
  // (chain takes ~4min serial for ~10 past meetings @ ~25s each; reload would interrupt it)
  function scheduleReload() {
    setTimeout(() => {
      if (window._hitChainActive) {
        // chain still running — defer reload by 30s, check again
        scheduleReload();
      } else {
        window.location.reload();
      }
    }, 60000);
  }
  scheduleReload();
</script>
</body></html>`;
}
