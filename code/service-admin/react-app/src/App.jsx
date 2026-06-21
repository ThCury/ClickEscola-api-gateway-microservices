import React from 'react'

/* -------------------------------------------------------------------------
 * Helper: converte uma string CSS ("padding:10px;color:red") num objeto de
 * estilo aceito pelo React. Mantém custom properties (--accent) intactas e
 * faz camelCase nas propriedades normais. Permite portar os estilos inline
 * do design com fidelidade total.
 * ---------------------------------------------------------------------- */
function css(str) {
  const out = {}
  if (!str) return out
  str.split(';').forEach((part) => {
    const i = part.indexOf(':')
    if (i < 0) return
    let key = part.slice(0, i).trim()
    const val = part.slice(i + 1).trim()
    if (!key) return
    if (!key.startsWith('--')) key = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    out[key] = val
  })
  return out
}

export default class ClickEscola extends React.Component {
  constructor(props) {
    super(props)
    const D = this.emptyData()
    this.D = D
    this.state = {
      theme: 'dark',
      tab: 'dashboard',
      direction: 'A',
      fText: '',
      fService: '',
      fMethod: '',
      fStatus: '',
      page: 1,
      cmpService: 'cursos',
      cmpN: 25,
      cmp: D.compare.cursos,
      cmpStatus: '',
      alSearch: '',
      cuSearch: '',
      alunos: D.alunos,
      cursos: D.cursos,
      config: { grafana: '', dozzle: '' },
      lokiOk: true,
      tick: 0,
      modal: null,
      loadPhase: 'idle',
      loadLog: '',
      loadResult: null,
      form: null,
      del: null,
      toast: null,
    }
  }

  componentDidMount() {
    this.loadConfig()
    this.refresh()
    this.loadCrud('alunos')
    this.loadCrud('cursos')
    this.fetchCompare()
    // auto-atualiza dashboard/tracing (pausa enquanto um modal está aberto).
    this._poll = setInterval(() => {
      if (!this.state.modal) this.refresh()
    }, 2500)
  }

  componentWillUnmount() {
    clearInterval(this._loadInt)
    clearInterval(this._poll)
    clearTimeout(this._tt)
  }

  /* ---------------- esqueleto de dados (preenchido pela API real) ---------------- */
  emptyData() {
    const zeroCmp = (service) => ({
      gateway: { min: null, avg: null, p50: null, p95: null, max: null },
      direct: { min: null, avg: null, p50: null, p95: null, max: null },
      overhead: null,
      n: 25,
      service,
    })
    return {
      series: { gateway: [], alunosReq: [], cursosReq: [], rl: [] },
      buckets: [],
      total: 0,
      alunos: [],
      cursos: [],
      traces: [],
      latency: { alunos: { gw: null, svc: null, count: 0 }, cursos: { gw: null, svc: null, count: 0 } },
      compare: { cursos: zeroCmp('cursos'), alunos: zeroCmp('alunos') },
      avgGw: null,
      avgSvc: null,
      reqPerMin: 0,
    }
  }

  /* ---------------- API real ---------------- */
  loadConfig() {
    fetch('/api/config')
      .then((r) => r.json())
      .then((c) => this.setState({ config: c }))
      .catch(() => {})
  }

  // Dashboard ao vivo: KPIs (/api/stats), séries dos gráficos (/api/metrics) e
  // a tabela de roteamento (/api/traces). Tudo num refresh só.
  refresh() {
    Promise.all([
      fetch('/api/stats').then((r) => r.json()),
      fetch('/api/metrics').then((r) => r.json()),
      fetch('/api/traces?limit=500').then((r) => r.json()),
    ])
      .then(([stats, metrics, traces]) => {
        this.applyStats(stats)
        this.applyMetrics(metrics)
        this.applyTraces(traces)
        this.setState({ tick: this.state.tick + 1 })
      })
      .catch(() => {})
  }

  applyStats(s) {
    this.D.total = s.total || 0
    this.D.avgGw = s.avg_gateway_to_service_ms
    this.D.avgSvc = s.avg_service_ms
  }

  applyMetrics(m) {
    const sr = m.series || {}
    this.D.series = {
      gateway: sr.gateway || [],
      alunosReq: sr.alunos || [],
      cursosReq: sr.cursos || [],
      rl: sr.rate_limited || [],
    }
    this.D.buckets = (sr.buckets || []).map((ts) => this.bucketLabel(ts))
    const by = {}
    ;(m.latency || []).forEach((l) => {
      by[l.service] = l
    })
    const la = by.alunos || {}
    const lc = by.cursos || {}
    this.D.latency = {
      alunos: { gw: la.avg_gateway_to_service_ms, svc: la.avg_service_ms, count: la.count || 0 },
      cursos: { gw: lc.avg_gateway_to_service_ms, svc: lc.avg_service_ms, count: lc.count || 0 },
    }
    const sumGw = this.D.series.gateway.reduce((a, b) => a + b, 0)
    const windowMin = ((sr.buckets ? sr.buckets.length : 0) * (sr.step_s || 10)) / 60
    this.D.reqPerMin = windowMin > 0 ? Math.round(sumGw / windowMin) : 0
    if (m.loki_ok === false && this.state.lokiOk) this.setState({ lokiOk: false })
    else if (m.loki_ok && !this.state.lokiOk) this.setState({ lokiOk: true })
  }

  applyTraces(data) {
    this.D.traces = (data.traces || []).map((x) => ({
      time: this.traceTime(x),
      service: x.service,
      method: x.method,
      path: x.path,
      status: x.status,
      gw: x.gateway_to_service_ms,
      svc: x.service_ms,
      total: x.total_ms,
      rid: x.request_id || '',
    }))
  }

  // "MM:SS" no fuso de Belo Horizonte a partir do epoch (segundos) do bucket.
  bucketLabel(ts) {
    const s = new Date(ts * 1000).toLocaleTimeString('pt-BR', {
      hour12: false,
      timeZone: 'America/Sao_Paulo',
    })
    return s.length >= 8 ? s.slice(3) : s
  }

  traceTime(x) {
    if (x.service_received_local) {
      const p = x.service_received_local.split(' ')
      return p.length === 2 ? p[1] : x.service_received_local
    }
    if (!x.service_received) return '—'
    const d = new Date(x.service_received)
    return (
      d.toLocaleTimeString('pt-BR', { hour12: false, timeZone: 'America/Sao_Paulo' }) +
      '.' +
      String(d.getMilliseconds()).padStart(3, '0')
    )
  }

  loadCrud(res) {
    fetch('/api/manage/' + res)
      .then((r) => r.json())
      .then((list) => this.setState({ [res]: Array.isArray(list) ? list : [] }))
      .catch(() => {})
  }

  /* ---------------- formatação ---------------- */
  fmtMs(v) {
    if (v == null) return '—'
    return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' ms'
  }
  msColor(v) {
    if (v == null) return 'var(--muted)'
    if (v < 5) return 'var(--green)'
    if (v < 50) return 'var(--orange)'
    return 'var(--red)'
  }
  stColor(s) {
    if (s >= 500) return 'var(--red)'
    if (s >= 400) return 'var(--orange)'
    return 'var(--green)'
  }
  badge(color) {
    return `display:inline-block;background:color-mix(in srgb,${color} 15%,transparent);color:${color};border:1px solid color-mix(in srgb,${color} 36%,transparent);padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;`
  }
  numCell(color) {
    return `padding:var(--rowpad,11px 14px);border-bottom:1px solid var(--line);font-size:13px;text-align:right;font-variant-numeric:tabular-nums;font-family:'IBM Plex Mono',monospace;color:${color};font-weight:600;`
  }
  statusCell(color) {
    return `padding:var(--rowpad,11px 14px);border-bottom:1px solid var(--line);font-size:13px;color:${color};font-weight:700;font-family:'IBM Plex Mono',monospace;`
  }

  /* ---------------- gráficos ---------------- */
  niceTicks(max, count) {
    const raw = max / count
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)))
    const norm = raw / mag
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
    const out = []
    for (let v = 0; v <= max + step; v += step) out.push(Math.round(v))
    return out.length > 1 ? out : [0, 1]
  }
  buildChart(seriesArrays) {
    const W = 760,
      H = 240,
      padL = 44,
      padR = 16,
      padT = 16,
      padB = 28
    const flat = [].concat(...seriesArrays)
    const maxY = Math.max(1, ...flat)
    const ticks = this.niceTicks(maxY, 4)
    const top = ticks[ticks.length - 1]
    const n = seriesArrays[0].length
    const iw = W - padL - padR,
      ih = H - padT - padB
    const X = (i) => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
    const Y = (v) => padT + ih - (v / top) * ih
    const gridlines = ticks.map((t) => {
      const y = +Y(t).toFixed(1)
      return { x1: padL, x2: W - padR, y, ty: y + 3, label: String(t) }
    })
    const lines = seriesArrays.map((s) => s.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '))
    return { W, H, padB, top, n, X, Y, gridlines, lines }
  }

  // Comparação real gateway × direto (GET /api/compare?service=&n=).
  fetchCompare() {
    const { cmpService, cmpN } = this.state
    this.setState({ cmpStatus: 'medindo…' })
    fetch(`/api/compare?service=${cmpService}&n=${parseInt(cmpN, 10) || 25}`)
      .then((r) => r.json())
      .then((d) => this.setState({ cmp: this.mapCompare(d), cmpStatus: '' }))
      .catch(() => this.setState({ cmpStatus: 'erro ao medir' }))
  }
  mapCompare(d) {
    const pick = (s) =>
      s
        ? { min: s.min, avg: s.avg, p50: s.p50, p95: s.p95, max: s.max }
        : { min: null, avg: null, p50: null, p95: null, max: null }
    return {
      gateway: pick(d.gateway),
      direct: pick(d.direct),
      overhead: d.overhead_ms,
      n: d.n || 25,
      service: d.service,
    }
  }

  toast(msg, isErr) {
    this.setState({ toast: { msg, isErr } })
    clearTimeout(this._tt)
    this._tt = setTimeout(() => this.setState({ toast: null }), 3200)
  }

  /* ---------------- CRUD ---------------- */
  openForm(res, item) {
    const data = item ? { ...item } : {}
    this.setState({ modal: 'form', form: { res, id: item ? item.id : null, data, err: {} } })
  }
  saveForm() {
    const f = this.state.form,
      res = f.res
    const err = {}
    const req = res === 'alunos' ? ['nome', 'email', 'matricula'] : ['nome', 'carga_horaria']
    req.forEach((k) => {
      if (!String(f.data[k] || '').trim()) err[k] = 'Campo obrigatório.'
    })
    if (res === 'cursos' && f.data.carga_horaria && (isNaN(+f.data.carga_horaria) || +f.data.carga_horaria < 1))
      err.carga_horaria = 'Informe um número ≥ 1.'
    if (Object.keys(err).length) {
      this.setState({ form: { ...f, err } })
      return
    }
    // monta o corpo só com os campos do recurso (sem o id).
    const body =
      res === 'alunos'
        ? { nome: f.data.nome, email: f.data.email, matricula: f.data.matricula }
        : { nome: f.data.nome, carga_horaria: +f.data.carga_horaria }
    const isEdit = !!f.id
    const url = isEdit ? `/api/manage/${res}/${f.id}` : `/api/manage/${res}`
    fetch(url, { method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + (await r.text()).slice(0, 140))
      })
      .then(() => {
        this.setState({ modal: null, form: null })
        this.toast((res === 'alunos' ? 'Aluno' : 'Curso') + (isEdit ? ' atualizado' : ' criado') + ' com sucesso.')
        this.loadCrud(res)
      })
      .catch((e) => this.toast('Erro ao salvar: ' + e.message, true))
  }
  askDelete(res, id, name) {
    this.setState({ modal: 'confirm', del: { res, id, name } })
  }
  doDelete() {
    const d = this.state.del
    fetch(`/api/manage/${d.res}/${d.id}`, { method: 'DELETE' })
      .then((r) => {
        if (!r.ok && r.status !== 204) throw new Error('HTTP ' + r.status)
      })
      .then(() => {
        this.setState({ modal: null, del: null })
        this.toast((d.res === 'alunos' ? 'Aluno' : 'Curso') + ' excluído.')
        this.loadCrud(d.res)
      })
      .catch((e) => {
        this.setState({ modal: null, del: null })
        this.toast('Erro ao excluir: ' + e.message, true)
      })
  }

  /* ---------------- teste de carga (real: POST /api/loadtest) ---------------- */
  runLoad() {
    this.setState({ loadPhase: 'running', loadLog: 'iniciando teste de carga…\n' })
    let tick = 0
    clearInterval(this._loadInt)
    // "log" ao vivo: amostra o total de requisições enquanto o backend dispara a carga.
    this._loadInt = setInterval(async () => {
      tick += 2
      try {
        const s = await (await fetch('/api/stats')).json()
        this.setState({ loadLog: this.state.loadLog + `t+${tick}s · requisições registradas: ${s.total}\n` })
      } catch (e) {}
      this.refresh()
    }, 2000)
    fetch('/api/loadtest', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        clearInterval(this._loadInt)
        this.setState({
          loadPhase: 'done',
          loadResult: {
            duration: d.duration_s + 's',
            rps: d.rps,
            total: d.total_requests,
            ok: d.ok,
            blocked: d.rate_limited_503,
          },
        })
        this.refresh()
      })
      .catch((e) => {
        clearInterval(this._loadInt)
        this.setState({ modal: null })
        this.toast('Erro no teste de carga: ' + e.message, true)
      })
  }

  /* ---------------- view-model ---------------- */
  vm() {
    const D = this.D,
      S = this.state
    const accentMap = { blue: '#2563eb', violet: '#7c3aed', emerald: '#059669', amber: '#d97706' }
    const accentColor = accentMap[this.props.accent] || accentMap.blue
    const density = this.props.density || 'comfortable'
    const cardPad = density === 'compact' ? '14px' : '20px'
    const rowPad = density === 'compact' ? '7px 11px' : '11px 15px'
    const livePulse = this.props.livePulse !== false

    const tabBase =
      'border:none;background:transparent;color:var(--muted);padding:9px 14px;font-size:14px;cursor:pointer;font-weight:600;border-radius:9px;border-bottom:2px solid transparent;'
    const tabActive =
      'border:none;background:var(--panel2);color:var(--txt);padding:9px 14px;font-size:14px;cursor:pointer;font-weight:600;border-radius:9px;border-bottom:2px solid var(--accent,' +
      accentColor +
      ');'
    const tabStyle = (name) => (S.tab === name ? tabActive : tabBase)

    const segActive =
      'border:none;background:var(--accent,' +
      accentColor +
      ');color:#fff;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;'
    const segIdle =
      'border:none;background:transparent;color:var(--muted);padding:7px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;'

    const liveDotStyle =
      'width:9px;height:9px;border-radius:50%;background:var(--green);display:inline-block;' +
      (livePulse ? 'animation:ce-pulse 1.8s infinite;' : '')

    const rc = this.buildChart([D.series.gateway, D.series.alunosReq, D.series.cursosReq])
    const stepL = Math.max(1, Math.ceil(rc.n / 7))
    const xlabels = D.buckets
      .map((b, i) => ({ x: +rc.X(i).toFixed(1), y: rc.H - 8, label: b }))
      .filter((_, i) => i % stepL === 0 || i === rc.n - 1)
    const reqChart = {
      gridlines: rc.gridlines,
      gatewayPts: rc.lines[0],
      alunosPts: rc.lines[1],
      cursosPts: rc.lines[2],
      xlabels,
    }

    const rl = this.buildChart([D.series.rl])
    const rlPts = rl.lines[0]
    const rlArea = `${rl.X(0).toFixed(1)},${rl.Y(0).toFixed(1)} ${rlPts} ${rl.X(rl.n - 1).toFixed(1)},${rl.Y(0).toFixed(1)}`
    const rlChart = {
      gridlines: rl.gridlines,
      pts: rlPts,
      areaPts: rlArea,
      total: D.series.rl.reduce((a, b) => a + b, 0),
      xlabels: D.buckets
        .map((b, i) => ({ x: +rl.X(i).toFixed(1), y: rl.H - 8, label: b }))
        .filter((_, i) => i % stepL === 0 || i === rl.n - 1),
    }

    const latMax = Math.max(D.latency.alunos.gw, D.latency.cursos.gw)

    const c = S.cmp
    const cmpMax = Math.max(c.gateway.avg, c.direct.avg) || 1
    const cmp = {
      serviceLabel: c.service === 'alunos' ? 'alunos (FastAPI)' : 'cursos (NestJS)',
      gwAvg: this.fmtMs(c.gateway.avg),
      dirAvg: this.fmtMs(c.direct.avg),
      gwP95: this.fmtMs(c.gateway.p95),
      dirP95: this.fmtMs(c.direct.p95),
      gwMin: this.fmtMs(c.gateway.min),
      gwMax: this.fmtMs(c.gateway.max),
      dirMin: this.fmtMs(c.direct.min),
      dirMax: this.fmtMs(c.direct.max),
      overhead: this.fmtMs(c.overhead),
      n: c.n,
      gwPct: Math.max(4, (c.gateway.avg / cmpMax) * 100) + '%',
      dirPct: Math.max(4, (c.direct.avg / cmpMax) * 100) + '%',
      statusText: S.cmpStatus,
    }

    const txt = S.fText.trim().toLowerCase()
    const filtered = D.traces.filter((x) => {
      if (S.fService && x.service !== S.fService) return false
      if (S.fMethod && x.method !== S.fMethod) return false
      if (S.fStatus && String(x.status).charAt(0) !== S.fStatus) return false
      if (txt && !(x.rid.toLowerCase().includes(txt) || x.path.toLowerCase().includes(txt))) return false
      return true
    })
    const size = 12
    const pages = Math.max(1, Math.ceil(filtered.length / size))
    const page = Math.min(S.page, pages)
    const start = (page - 1) * size
    const slice = filtered.slice(start, start + size)
    const methodColor = { GET: 'var(--blue)', POST: 'var(--orange)', PUT: 'var(--cyan)', DELETE: 'var(--red)' }
    const traceRows = slice.map((x) => ({
      time: x.time,
      service: x.service,
      method: x.method,
      path: x.path,
      status: x.status,
      gw: this.fmtMs(x.gw),
      svc: this.fmtMs(x.svc),
      total: this.fmtMs(x.total),
      rid: x.rid.slice(0, 12),
      svcStyle: this.badge(x.service === 'alunos' ? 'var(--green)' : 'var(--purple)'),
      methodStyle: this.badge(methodColor[x.method] || 'var(--muted)'),
      statusStyle: this.statusCell(this.stColor(x.status)),
      gwStyle: this.numCell(this.msColor(x.gw)),
      svcMsStyle: this.numCell(this.msColor(x.svc)),
    }))
    const pgInfo = filtered.length
      ? `${start + 1}–${Math.min(start + size, filtered.length)} de ${filtered.length}`
      : '0 resultados'

    const alq = S.alSearch.trim().toLowerCase()
    const alunosRows = S.alunos
      .filter((a) => !alq || [a.nome, a.email, a.matricula].some((v) => (v || '').toLowerCase().includes(alq)))
      .map((a) => ({
        ...a,
        shortId: a.id.slice(0, 8) + '…',
        onEdit: () => this.openForm('alunos', a),
        onDelete: () => this.askDelete('alunos', a.id, a.nome),
      }))
    const cuq = S.cuSearch.trim().toLowerCase()
    const cursosRows = S.cursos
      .filter((c2) => !cuq || c2.nome.toLowerCase().includes(cuq) || String(c2.carga_horaria).includes(cuq))
      .map((c2) => ({
        id: c2.id,
        nome: c2.nome,
        carga: c2.carga_horaria + ' h',
        shortId: c2.id.slice(0, 8) + '…',
        onEdit: () => this.openForm('cursos', c2),
        onDelete: () => this.askDelete('cursos', c2.id, c2.nome),
      }))

    let formFields = [],
      formTitle = ''
    if (S.form) {
      const schema =
        S.form.res === 'alunos'
          ? [
              { k: 'nome', label: 'Nome', type: 'text', ph: 'Nome completo' },
              { k: 'email', label: 'E-mail', type: 'email', ph: 'nome@clickescola.edu' },
              { k: 'matricula', label: 'Matrícula', type: 'text', ph: '2024000' },
            ]
          : [
              { k: 'nome', label: 'Nome', type: 'text', ph: 'Nome do curso' },
              { k: 'carga_horaria', label: 'Carga horária (h)', type: 'number', ph: '60' },
            ]
      formTitle = (S.form.id ? 'Editar ' : 'Novo ') + (S.form.res === 'alunos' ? 'aluno' : 'curso')
      formFields = schema.map((f) => ({
        key: f.k,
        label: f.label,
        type: f.type,
        placeholder: f.ph,
        value: S.form.data[f.k] == null ? '' : String(S.form.data[f.k]),
        hasError: !!(S.form.err && S.form.err[f.k]),
        error: (S.form.err && S.form.err[f.k]) || '',
        onInput: (e) => {
          const data = { ...this.state.form.data, [f.k]: e.target.value }
          this.setState({ form: { ...this.state.form, data } })
        },
      }))
    }

    const toastStyle =
      'position:fixed;bottom:24px;right:24px;background:var(--panel);border:1px solid ' +
      (S.toast && S.toast.isErr ? 'var(--red)' : 'var(--line)') +
      ';padding:14px 20px;border-radius:12px;max-width:360px;font-size:13.5px;box-shadow:0 18px 60px rgba(0,0,0,.45);z-index:80;color:var(--txt);'

    return {
      theme: S.theme,
      accentColor,
      cardPad,
      rowPad,
      liveDotStyle,
      themeIcon: S.theme === 'dark' ? '🌙' : '☀️',
      toggleTheme: () => this.setState({ theme: S.theme === 'dark' ? 'light' : 'dark' }),
      tabDashStyle: tabStyle('dashboard'),
      tabAlunosStyle: tabStyle('alunos'),
      tabCursosStyle: tabStyle('cursos'),
      isDash: S.tab === 'dashboard',
      isAlunos: S.tab === 'alunos',
      isCursos: S.tab === 'cursos',
      setTab: (t) => {
        this.setState({ tab: t })
        if (t === 'alunos' || t === 'cursos') this.loadCrud(t)
      },
      openGrafana: () => {
        const u = S.config && S.config.grafana
        if (u) window.open(u, '_blank', 'noopener')
      },
      openDozzle: () => {
        const u = S.config && S.config.dozzle
        if (u) window.open(u, '_blank', 'noopener')
      },

      dirA: S.direction === 'A',
      dirB: S.direction === 'B',
      setDir: (d) => this.setState({ direction: d }),
      dirAStyle: S.direction === 'A' ? segActive : segIdle,
      dirBStyle: S.direction === 'B' ? segActive : segIdle,

      kTotal: D.total.toLocaleString('pt-BR'),
      kReqPerMin: D.reqPerMin,
      kAvgGw: this.fmtMs(D.avgGw),
      kAvgSvc: this.fmtMs(D.avgSvc),
      kCounts: S.alunos.length + ' / ' + S.cursos.length,

      reqChart,
      rlChart,
      latAlunosPct: Math.max(8, (D.latency.alunos.gw / latMax) * 100) + '%',
      latAlunosGw: this.fmtMs(D.latency.alunos.gw),
      latAlunosSvc: this.fmtMs(D.latency.alunos.svc),
      latCursosPct: Math.max(8, (D.latency.cursos.gw / latMax) * 100) + '%',
      latCursosGw: this.fmtMs(D.latency.cursos.gw),
      latCursosSvc: this.fmtMs(D.latency.cursos.svc),
      latCount: D.latency.alunos.count + D.latency.cursos.count,
      badgeAlunos: this.badge('var(--green)'),
      badgeCursos: this.badge('var(--purple)'),

      fText: S.fText,
      fService: S.fService,
      fMethod: S.fMethod,
      fStatus: S.fStatus,
      onFText: (e) => this.setState({ fText: e.target.value, page: 1 }),
      onFService: (e) => this.setState({ fService: e.target.value, page: 1 }),
      onFMethod: (e) => this.setState({ fMethod: e.target.value, page: 1 }),
      onFStatus: (e) => this.setState({ fStatus: e.target.value, page: 1 }),
      clearFilters: () => this.setState({ fText: '', fService: '', fMethod: '', fStatus: '', page: 1 }),
      traceRows,
      noTraces: traceRows.length === 0,
      pgInfo,
      pgPrev: () => this.setState({ page: Math.max(1, page - 1) }),
      pgNext: () => this.setState({ page: Math.min(pages, page + 1) }),

      cmp,
      cmpService: S.cmpService,
      cmpN: S.cmpN,
      onCmpService: (e) => {
        this.setState({ cmpService: e.target.value, cmp: this.D.compare[e.target.value] }, () => this.fetchCompare())
      },
      onCmpN: (e) => this.setState({ cmpN: e.target.value }),
      runCompare: () => this.fetchCompare(),

      alCount: S.alunos.length,
      cuCount: S.cursos.length,
      alSearch: S.alSearch,
      cuSearch: S.cuSearch,
      onAlSearch: (e) => this.setState({ alSearch: e.target.value }),
      onCuSearch: (e) => this.setState({ cuSearch: e.target.value }),
      alunosRows,
      noAlunos: alunosRows.length === 0,
      newAluno: () => this.openForm('alunos', null),
      cursosRows,
      noCursos: cursosRows.length === 0,
      newCurso: () => this.openForm('cursos', null),

      showLoad: S.modal === 'load',
      showForm: S.modal === 'form',
      showConfirm: S.modal === 'confirm',
      loadIdle: S.loadPhase === 'idle',
      loadRunning: S.loadPhase === 'running',
      loadDone: S.loadPhase === 'done',
      loadLog: S.loadLog,
      loadResult: S.loadResult,
      openLoad: () => this.setState({ modal: 'load', loadPhase: 'idle', loadLog: '', loadResult: null }),
      closeLoad: () => {
        clearInterval(this._loadInt)
        this.setState({ modal: null })
      },
      runLoad: () => this.runLoad(),
      formTitle,
      formFields,
      closeForm: () => this.setState({ modal: null, form: null }),
      saveForm: () => this.saveForm(),
      delName: S.del ? S.del.name : '',
      closeConfirm: () => this.setState({ modal: null, del: null }),
      doDelete: () => this.doDelete(),
      closeModalBg: () => {
        clearInterval(this._loadInt)
        this.setState({ modal: null, form: null, del: null })
      },

      showToast: !!S.toast,
      toastMsg: S.toast ? S.toast.msg : '',
      toastStyle,
    }
  }

  render() {
    const v = this.vm()

    const card = 'background:var(--panel);border:1px solid var(--line);border-radius:16px;'
    const cardHead =
      'display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap;'
    const h2 = 'font-size:16px;margin:0;font-weight:600;'
    const hint = 'color:var(--muted);font-size:12.5px;'
    const inputStyle =
      "background:var(--panel2);border:1px solid var(--line);color:var(--txt);padding:9px 11px;border-radius:9px;font-size:13.5px;font-family:inherit;"
    const th = (align) =>
      `text-align:${align};padding:var(--rowpad,11px 15px);border-bottom:1px solid var(--line);color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;position:sticky;top:0;background:var(--panel);`
    const thPlain = (align) =>
      `text-align:${align};padding:13px 18px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;`

    const KpiCard = ({ accent, label, value, sub, mono }) => (
      <div style={css(card + 'padding:20px 22px;position:relative;overflow:hidden;')}>
        <div style={{ ...css('position:absolute;top:0;left:0;width:4px;height:100%;'), background: accent }} />
        <div style={css('font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;font-weight:600;')}>
          {label}
        </div>
        <div
          style={css(
            'font-size:46px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.02;margin-top:10px;' +
              (mono ? "font-family:'IBM Plex Mono',monospace;" : '')
          )}
        >
          {value}
        </div>
        <div style={css('font-size:12.5px;color:var(--muted);margin-top:6px;')}>{sub}</div>
      </div>
    )

    const LineChart = (chart, withArea) => (
      <svg viewBox="0 0 760 240" style={{ width: '100%', height: 'auto', display: 'block' }}>
        {chart.gridlines.map((g, i) => (
          <g key={'g' + i}>
            <line x1={g.x1} y1={g.y} x2={g.x2} y2={g.y} stroke="var(--grid)" strokeWidth="1" />
            <text x="38" y={g.ty} textAnchor="end" fill="var(--muted)" fontSize="10" fontFamily="'IBM Plex Mono',monospace">
              {g.label}
            </text>
          </g>
        ))}
        {chart.xlabels.map((x, i) => (
          <text key={'x' + i} x={x.x} y={x.y} textAnchor="middle" fill="var(--muted)" fontSize="10" fontFamily="'IBM Plex Mono',monospace">
            {x.label}
          </text>
        ))}
        {withArea ? (
          <>
            <polygon points={chart.areaPts} fill="var(--red)" opacity="0.16" />
            <polyline points={chart.pts} fill="none" stroke="var(--red)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
          </>
        ) : (
          <>
            <polyline points={chart.cursosPts} fill="none" stroke="var(--purple)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={chart.alunosPts} fill="none" stroke="var(--green)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={chart.gatewayPts} fill="none" stroke="var(--accent,#2563eb)" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
      </svg>
    )

    return (
      <div
        data-theme={v.theme}
        style={{
          '--accent': v.accentColor,
          '--cardpad': v.cardPad,
          '--rowpad': v.rowPad,
          ...css(
            "font-family:'IBM Plex Sans',system-ui,sans-serif;color:var(--txt);min-height:100vh;background:radial-gradient(1100px 560px at 82% -12%, var(--bg2) 0%, var(--bg) 58%);transition:background .25s,color .25s;-webkit-font-smoothing:antialiased;"
          ),
        }}
      >
        {/* ===== HEADER ===== */}
        <header
          style={css(
            'display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:14px 28px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 72%,transparent);backdrop-filter:blur(8px);position:sticky;top:0;z-index:20;'
          )}
        >
          <div style={css('display:flex;align-items:center;gap:12px;')}>
            <div style={css('width:34px;height:34px;border-radius:9px;background:var(--accent,#2563eb);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:17px;')}>
              C
            </div>
            <div>
              <div style={css('font-size:17px;font-weight:700;letter-spacing:.2px;')}>ClickEscola</div>
              <div style={css('font-size:11.5px;color:var(--muted);letter-spacing:.3px;')}>
                API Gateway · Microsserviços · Observabilidade
              </div>
            </div>
          </div>

          <nav style={css('display:flex;gap:4px;margin-left:8px;')}>
            <button onClick={() => v.setTab('dashboard')} style={css(v.tabDashStyle)}>Dashboard</button>
            <button onClick={() => v.setTab('alunos')} style={css(v.tabAlunosStyle)}>Alunos</button>
            <button onClick={() => v.setTab('cursos')} style={css(v.tabCursosStyle)}>Cursos</button>
          </nav>

          <div style={{ flex: 1 }} />

          <button onClick={v.toggleTheme} title="Alternar tema" style={css('border:1px solid var(--line);background:var(--panel2);color:var(--txt);width:40px;height:40px;border-radius:10px;cursor:pointer;font-size:16px;display:inline-flex;align-items:center;justify-content:center;')}>
            {v.themeIcon}
          </button>
          <button onClick={v.openGrafana} style={css('border:1px solid var(--line);background:var(--panel2);color:var(--txt);padding:0 14px;height:40px;border-radius:10px;cursor:pointer;font-size:13.5px;display:inline-flex;align-items:center;gap:8px;')}>
            📈 Grafana
          </button>
          <button onClick={v.openDozzle} style={css('border:1px solid var(--line);background:var(--panel2);color:var(--txt);padding:0 14px;height:40px;border-radius:10px;cursor:pointer;font-size:13.5px;display:inline-flex;align-items:center;gap:8px;')}>
            📜 Dozzle
          </button>
          <button onClick={v.openLoad} style={css('border:1px solid var(--accent,#2563eb);background:var(--accent,#2563eb);color:#fff;padding:0 16px;height:40px;border-radius:10px;cursor:pointer;font-size:13.5px;font-weight:600;display:inline-flex;align-items:center;gap:8px;')}>
            ⚡ Teste de carga
          </button>
        </header>

        <main style={css('padding:24px 28px 72px;max-width:1340px;margin:0 auto;display:flex;flex-direction:column;gap:22px;')}>
          {/* ===== DASHBOARD ===== */}
          {v.isDash && (
            <>
              <div style={css('display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;')}>
                <div>
                  <h1 style={css('margin:0;font-size:26px;font-weight:700;letter-spacing:-.3px;')}>Visão geral</h1>
                  <div style={css('font-size:13.5px;color:var(--muted);margin-top:4px;display:flex;align-items:center;gap:10px;')}>
                    <span style={css(v.liveDotStyle)} /> dados ao vivo · janela de 5 min · fonte: Loki tracing
                  </div>
                </div>
                <div style={css('display:flex;align-items:center;gap:10px;')}>
                  <span style={css('font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;font-weight:600;')}>Layout</span>
                  <div style={css('display:flex;background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:4px;gap:4px;')}>
                    <button onClick={() => v.setDir('A')} style={css(v.dirAStyle)}>A · Equilíbrio</button>
                    <button onClick={() => v.setDir('B')} style={css(v.dirBStyle)}>B · Performance</button>
                  </div>
                </div>
              </div>

              {/* Direção A */}
              {v.dirA && (
                <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px;')}>
                  <KpiCard accent="var(--blue)" label="Requisições · total" value={v.kTotal} sub={v.kReqPerMin + ' req/min em média'} />
                  <KpiCard accent="var(--accent,#2563eb)" label="Salto gateway → serviço" value={v.kAvgGw} sub="overhead médio do gateway" mono />
                  <KpiCard accent="var(--green)" label="Tempo no serviço" value={v.kAvgSvc} sub="processamento dentro do serviço" mono />
                  <KpiCard accent="var(--purple)" label="Cadastros" value={v.kCounts} sub="alunos / cursos" />
                </div>
              )}

              {/* Direção B */}
              {v.dirB && (
                <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:18px;')}>
                  <div style={css(card + 'border-radius:18px;padding:26px 28px;display:flex;flex-direction:column;')}>
                    <div style={css('font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;font-weight:600;')}>Requisições na janela</div>
                    <div style={css('display:flex;align-items:flex-end;gap:14px;margin-top:6px;')}>
                      <div style={css('font-size:72px;font-weight:700;font-variant-numeric:tabular-nums;line-height:.95;letter-spacing:-1px;')}>{v.kTotal}</div>
                      <div style={css('font-size:13px;color:var(--green);font-weight:600;padding-bottom:12px;')}>{v.kReqPerMin} req/min</div>
                    </div>
                    <svg viewBox="0 0 760 240" preserveAspectRatio="none" style={{ width: '100%', height: '96px', marginTop: '14px', display: 'block' }}>
                      <polyline points={v.reqChart.gatewayPts} fill="none" stroke="var(--accent,#2563eb)" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
                    </svg>
                    <div style={css('display:flex;gap:26px;margin-top:18px;padding-top:18px;border-top:1px solid var(--line);')}>
                      <div>
                        <div style={css('font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;')}>gateway → serviço</div>
                        <div style={css("font-size:24px;font-weight:700;font-family:'IBM Plex Mono',monospace;margin-top:3px;")}>{v.kAvgGw}</div>
                      </div>
                      <div>
                        <div style={css('font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;')}>no serviço</div>
                        <div style={css("font-size:24px;font-weight:700;font-family:'IBM Plex Mono',monospace;margin-top:3px;")}>{v.kAvgSvc}</div>
                      </div>
                      <div>
                        <div style={css('font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;')}>alunos / cursos</div>
                        <div style={css('font-size:24px;font-weight:700;margin-top:3px;')}>{v.kCounts}</div>
                      </div>
                    </div>
                  </div>

                  <div style={css(card + 'border-radius:18px;padding:26px 28px;display:flex;flex-direction:column;')}>
                    <div style={css('display:flex;align-items:center;justify-content:space-between;gap:12px;')}>
                      <div style={css('font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;font-weight:600;')}>Custo do gateway · {v.cmp.serviceLabel}</div>
                      <button onClick={v.runCompare} style={css('border:1px solid var(--line);background:var(--panel2);color:var(--txt);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12.5px;')}>↻ recalcular</button>
                    </div>
                    <div style={css('display:flex;align-items:flex-end;gap:12px;margin-top:6px;')}>
                      <div style={css("font-size:64px;font-weight:700;font-variant-numeric:tabular-nums;line-height:.95;color:var(--orange);font-family:'IBM Plex Mono',monospace;")}>+{v.cmp.overhead}</div>
                      <div style={css('font-size:14px;color:var(--muted);padding-bottom:12px;')}>overhead médio</div>
                    </div>
                    <div style={css('display:grid;gap:12px;margin-top:20px;')}>
                      <div>
                        <div style={css('display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;')}>
                          <span>Via gateway</span>
                          <span style={css("font-family:'IBM Plex Mono',monospace;color:var(--muted);")}>{v.cmp.gwAvg}</span>
                        </div>
                        <div style={css('background:var(--panel2);border:1px solid var(--line);border-radius:9px;height:26px;overflow:hidden;')}>
                          <div style={{ ...css('height:100%;background:var(--accent,#2563eb);border-radius:8px 0 0 8px;transition:width .5s ease;'), width: v.cmp.gwPct }} />
                        </div>
                      </div>
                      <div>
                        <div style={css('display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;')}>
                          <span>Acesso direto</span>
                          <span style={css("font-family:'IBM Plex Mono',monospace;color:var(--muted);")}>{v.cmp.dirAvg}</span>
                        </div>
                        <div style={css('background:var(--panel2);border:1px solid var(--line);border-radius:9px;height:26px;overflow:hidden;')}>
                          <div style={{ ...css('height:100%;background:var(--green);border-radius:8px 0 0 8px;transition:width .5s ease;'), width: v.cmp.dirPct }} />
                        </div>
                      </div>
                    </div>
                    <div style={css('font-size:12px;color:var(--muted);margin-top:16px;padding-top:14px;border-top:1px solid var(--line);')}>
                      p95 via gateway <b style={css("color:var(--txt);font-family:'IBM Plex Mono',monospace;")}>{v.cmp.gwP95}</b> · {v.cmp.n} amostras
                    </div>
                  </div>
                </div>
              )}

              {/* Requisições ao longo do tempo */}
              <section style={css(card)}>
                <div style={css(cardHead)}>
                  <h2 style={css(h2)}>Requisições recebidas — gateway × serviços</h2>
                  <span style={css(hint)}>contagem por janela de 10 s</span>
                  <div style={{ flex: 1 }} />
                  <div style={css('display:flex;gap:18px;font-size:12.5px;color:var(--muted);')}>
                    <span style={css('display:inline-flex;align-items:center;gap:6px;')}><span style={css('width:12px;height:3px;border-radius:2px;background:var(--accent,#2563eb);display:inline-block;')} />Gateway</span>
                    <span style={css('display:inline-flex;align-items:center;gap:6px;')}><span style={css('width:12px;height:3px;border-radius:2px;background:var(--green);display:inline-block;')} />Alunos</span>
                    <span style={css('display:inline-flex;align-items:center;gap:6px;')}><span style={css('width:12px;height:3px;border-radius:2px;background:var(--purple);display:inline-block;')} />Cursos</span>
                  </div>
                </div>
                <div style={css('padding:var(--cardpad,20px);')}>{LineChart(v.reqChart, false)}</div>
              </section>

              {/* 503 + latência */}
              <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:22px;')}>
                <section style={css(card)}>
                  <div style={css(cardHead)}>
                    <h2 style={css(h2)}>Barradas por rate limit (503)</h2>
                    <span style={css(hint)}>limite: 10 req/s</span>
                    <div style={{ flex: 1 }} />
                    <span style={css('font-size:13px;color:var(--muted);')}>total: <b style={css("color:var(--red);font-family:'IBM Plex Mono',monospace;")}>{v.rlChart.total}</b></span>
                  </div>
                  <div style={css('padding:var(--cardpad,20px);')}>{LineChart(v.rlChart, true)}</div>
                </section>

                <section style={css(card)}>
                  <div style={css(cardHead)}>
                    <h2 style={css(h2)}>Tempo médio até o serviço</h2>
                    <span style={css(hint)}>salto gateway → serviço</span>
                  </div>
                  <div style={css('padding:var(--cardpad,20px);display:grid;gap:18px;')}>
                    <div style={css('display:grid;grid-template-columns:90px 1fr 130px;align-items:center;gap:14px;')}>
                      <span style={css(v.badgeAlunos)}>alunos</span>
                      <div style={css('background:var(--panel2);border:1px solid var(--line);border-radius:9px;height:30px;overflow:hidden;')}>
                        <div style={{ ...css("height:100%;background:var(--green);border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;font-size:12px;font-weight:700;color:#06231a;font-family:'IBM Plex Mono',monospace;transition:width .5s ease;"), width: v.latAlunosPct }}>{v.latAlunosGw}</div>
                      </div>
                      <span style={css('font-size:12px;color:var(--muted);')}>no svc: <b style={css("color:var(--txt);font-family:'IBM Plex Mono',monospace;")}>{v.latAlunosSvc}</b></span>
                    </div>
                    <div style={css('display:grid;grid-template-columns:90px 1fr 130px;align-items:center;gap:14px;')}>
                      <span style={css(v.badgeCursos)}>cursos</span>
                      <div style={css('background:var(--panel2);border:1px solid var(--line);border-radius:9px;height:30px;overflow:hidden;')}>
                        <div style={{ ...css("height:100%;background:var(--purple);border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;font-size:12px;font-weight:700;color:#1d0a2e;font-family:'IBM Plex Mono',monospace;transition:width .5s ease;"), width: v.latCursosPct }}>{v.latCursosGw}</div>
                      </div>
                      <span style={css('font-size:12px;color:var(--muted);')}>no svc: <b style={css("color:var(--txt);font-family:'IBM Plex Mono',monospace;")}>{v.latCursosSvc}</b></span>
                    </div>
                    <div style={css('font-size:12px;color:var(--muted);padding-top:6px;border-top:1px solid var(--line);')}>Janela recente · {v.latCount} amostras medidas.</div>
                  </div>
                </section>
              </div>

              {/* Tabela de roteamento */}
              <section style={css(card)}>
                <div style={css(cardHead)}>
                  <h2 style={css(h2)}>Roteamento das requisições</h2>
                  <span style={css(hint)}>cliente → gateway → serviço · tempos em ms</span>
                </div>
                <div style={css('padding:var(--cardpad,20px);')}>
                  <div style={css('display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;')}>
                    <input type="search" value={v.fText} onInput={v.onFText} onChange={v.onFText} placeholder="🔎 buscar por request_id ou rota…" style={css(inputStyle + 'min-width:240px;flex:1;max-width:320px;')} />
                    <select value={v.fService} onChange={v.onFService} style={css(inputStyle)}>
                      <option value="">serviço: todos</option>
                      <option value="alunos">alunos</option>
                      <option value="cursos">cursos</option>
                    </select>
                    <select value={v.fMethod} onChange={v.onFMethod} style={css(inputStyle)}>
                      <option value="">método: todos</option>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="DELETE">DELETE</option>
                    </select>
                    <select value={v.fStatus} onChange={v.onFStatus} style={css(inputStyle)}>
                      <option value="">status: todos</option>
                      <option value="2">2xx</option>
                      <option value="4">4xx</option>
                      <option value="5">5xx</option>
                    </select>
                    <div style={{ flex: 1 }} />
                    <button onClick={v.clearFilters} style={css('border:1px solid var(--line);background:transparent;color:var(--muted);padding:9px 14px;border-radius:9px;cursor:pointer;font-size:13px;')}>limpar</button>
                  </div>
                  <div style={css('max-height:440px;overflow:auto;border:1px solid var(--line);border-radius:12px;')}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={css(th('left'))}>Hora</th>
                          <th style={css(th('left'))}>Serviço</th>
                          <th style={css(th('left'))}>Método</th>
                          <th style={css(th('left'))}>Rota</th>
                          <th style={css(th('left'))}>Status</th>
                          <th style={css(th('right'))}>GW→Svc</th>
                          <th style={css(th('right'))}>No svc</th>
                          <th style={css(th('right'))}>Total</th>
                          <th style={css(th('left'))}>request_id</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v.traceRows.map((r, i) => (
                          <tr key={i} className="ce-row">
                            <td style={css("padding:var(--rowpad,11px 15px);border-bottom:1px solid var(--line);font-size:13px;font-family:'IBM Plex Mono',monospace;color:var(--muted);white-space:nowrap;")}>{r.time}</td>
                            <td style={css('padding:var(--rowpad,11px 15px);border-bottom:1px solid var(--line);font-size:13px;')}><span style={css(r.svcStyle)}>{r.service}</span></td>
                            <td style={css('padding:var(--rowpad,11px 15px);border-bottom:1px solid var(--line);font-size:13px;')}><span style={css(r.methodStyle)}>{r.method}</span></td>
                            <td style={css("padding:var(--rowpad,11px 15px);border-bottom:1px solid var(--line);font-size:13px;font-family:'IBM Plex Mono',monospace;color:var(--muted);")}>{r.path}</td>
                            <td style={css(r.statusStyle)}>{r.status}</td>
                            <td style={css(r.gwStyle)}>{r.gw}</td>
                            <td style={css(r.svcMsStyle)}>{r.svc}</td>
                            <td style={css("padding:var(--rowpad,11px 15px);border-bottom:1px solid var(--line);font-size:13px;text-align:right;font-variant-numeric:tabular-nums;font-family:'IBM Plex Mono',monospace;")}>{r.total}</td>
                            <td style={css("padding:var(--rowpad,11px 15px);border-bottom:1px solid var(--line);font-size:13px;font-family:'IBM Plex Mono',monospace;color:var(--muted);")}>{r.rid}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {v.noTraces && <div style={css('text-align:center;color:var(--muted);padding:30px 10px;font-size:14px;')}>Nenhuma requisição para esse filtro.</div>}
                  </div>
                  <div style={css('display:flex;align-items:center;gap:14px;justify-content:flex-end;margin-top:14px;font-size:13px;')}>
                    <span style={css('color:var(--muted);')}>{v.pgInfo}</span>
                    <button onClick={v.pgPrev} style={css('border:1px solid var(--line);background:var(--panel2);color:var(--txt);padding:7px 14px;border-radius:9px;cursor:pointer;font-size:13px;')}>‹ anterior</button>
                    <button onClick={v.pgNext} style={css('border:1px solid var(--line);background:var(--panel2);color:var(--txt);padding:7px 14px;border-radius:9px;cursor:pointer;font-size:13px;')}>próxima ›</button>
                  </div>
                </div>
              </section>

              {/* Comparação (somente Direção A) */}
              {v.dirA && (
                <section style={css(card)}>
                  <div style={css(cardHead)}>
                    <h2 style={css(h2)}>Comparação: via Gateway × Direto</h2>
                    <span style={css(hint)}>latência de N requisições (ms)</span>
                  </div>
                  <div style={css('padding:var(--cardpad,20px);')}>
                    <div style={css('display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:20px;')}>
                      <select value={v.cmpService} onChange={v.onCmpService} style={css(inputStyle)}>
                        <option value="cursos">cursos (NestJS)</option>
                        <option value="alunos">alunos (FastAPI)</option>
                      </select>
                      <label style={css('font-size:13px;color:var(--muted);display:inline-flex;align-items:center;gap:8px;')}>
                        Amostras
                        <input type="number" value={v.cmpN} onInput={v.onCmpN} onChange={v.onCmpN} min="5" max="100" style={css(inputStyle + 'width:80px;')} />
                      </label>
                      <button onClick={v.runCompare} style={css('border:1px solid var(--accent,#2563eb);background:var(--accent,#2563eb);color:#fff;padding:9px 16px;border-radius:9px;cursor:pointer;font-size:13.5px;font-weight:600;')}>▶ Rodar comparação</button>
                      <span style={css('font-size:13px;color:var(--muted);')}>{v.cmp.statusText}</span>
                    </div>
                    <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px;align-items:start;')}>
                      <div style={css('display:grid;gap:14px;')}>
                        <div style={css('display:grid;grid-template-columns:110px 1fr 90px;align-items:center;gap:14px;')}>
                          <span style={css('font-size:13.5px;')}>Via gateway</span>
                          <div style={css('background:var(--panel2);border:1px solid var(--line);border-radius:9px;height:30px;overflow:hidden;')}>
                            <div style={{ ...css("height:100%;background:var(--accent,#2563eb);border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;font-size:12px;font-weight:700;color:#fff;font-family:'IBM Plex Mono',monospace;transition:width .5s ease;"), width: v.cmp.gwPct }}>{v.cmp.gwAvg}</div>
                          </div>
                          <span style={css('font-size:12px;color:var(--muted);text-align:right;')}>p95 {v.cmp.gwP95}</span>
                        </div>
                        <div style={css('display:grid;grid-template-columns:110px 1fr 90px;align-items:center;gap:14px;')}>
                          <span style={css('font-size:13.5px;')}>Direto</span>
                          <div style={css('background:var(--panel2);border:1px solid var(--line);border-radius:9px;height:30px;overflow:hidden;')}>
                            <div style={{ ...css("height:100%;background:var(--green);border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;font-size:12px;font-weight:700;color:#06231a;font-family:'IBM Plex Mono',monospace;transition:width .5s ease;"), width: v.cmp.dirPct }}>{v.cmp.dirAvg}</div>
                          </div>
                          <span style={css('font-size:12px;color:var(--muted);text-align:right;')}>p95 {v.cmp.dirP95}</span>
                        </div>
                        <div style={css('font-size:13px;color:var(--muted);margin-top:6px;')}>Overhead do gateway: <b style={css("color:var(--orange);font-family:'IBM Plex Mono',monospace;")}>+{v.cmp.overhead}</b> em média ({v.cmp.n} amostras).</div>
                      </div>
                      <div style={css('border:1px solid var(--line);border-radius:12px;overflow:hidden;')}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={css('text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;background:var(--panel2);')}>Caminho</th>
                              <th style={css('text-align:right;padding:10px 12px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;text-transform:uppercase;background:var(--panel2);')}>min</th>
                              <th style={css('text-align:right;padding:10px 12px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;text-transform:uppercase;background:var(--panel2);')}>média</th>
                              <th style={css('text-align:right;padding:10px 12px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;text-transform:uppercase;background:var(--panel2);')}>p95</th>
                              <th style={css('text-align:right;padding:10px 12px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;text-transform:uppercase;background:var(--panel2);')}>max</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td style={css('padding:10px 12px;border-bottom:1px solid var(--line);font-size:13px;')}>Via gateway</td>
                              <td style={css("padding:10px 12px;border-bottom:1px solid var(--line);font-size:13px;text-align:right;font-family:'IBM Plex Mono',monospace;")}>{v.cmp.gwMin}</td>
                              <td style={css("padding:10px 12px;border-bottom:1px solid var(--line);font-size:13px;text-align:right;font-family:'IBM Plex Mono',monospace;")}>{v.cmp.gwAvg}</td>
                              <td style={css("padding:10px 12px;border-bottom:1px solid var(--line);font-size:13px;text-align:right;font-family:'IBM Plex Mono',monospace;")}>{v.cmp.gwP95}</td>
                              <td style={css("padding:10px 12px;border-bottom:1px solid var(--line);font-size:13px;text-align:right;font-family:'IBM Plex Mono',monospace;")}>{v.cmp.gwMax}</td>
                            </tr>
                            <tr>
                              <td style={css('padding:10px 12px;font-size:13px;')}>Direto</td>
                              <td style={css("padding:10px 12px;font-size:13px;text-align:right;font-family:'IBM Plex Mono',monospace;")}>{v.cmp.dirMin}</td>
                              <td style={css("padding:10px 12px;font-size:13px;text-align:right;font-family:'IBM Plex Mono',monospace;")}>{v.cmp.dirAvg}</td>
                              <td style={css("padding:10px 12px;font-size:13px;text-align:right;font-family:'IBM Plex Mono',monospace;")}>{v.cmp.dirP95}</td>
                              <td style={css("padding:10px 12px;font-size:13px;text-align:right;font-family:'IBM Plex Mono',monospace;")}>{v.cmp.dirMax}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </section>
              )}
            </>
          )}

          {/* ===== ALUNOS ===== */}
          {v.isAlunos && (
            <>
              <div style={css('display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;')}>
                <div>
                  <h1 style={css('margin:0;font-size:26px;font-weight:700;letter-spacing:-.3px;')}>Alunos</h1>
                  <div style={css('font-size:13.5px;color:var(--muted);margin-top:4px;')}>CRUD · keyspace <code style={css("font-family:'IBM Plex Mono',monospace;")}>alunos_ks.alunos</code> · {v.alCount} registros</div>
                </div>
                <div style={css('display:flex;gap:10px;align-items:center;')}>
                  <input type="search" value={v.alSearch} onInput={v.onAlSearch} onChange={v.onAlSearch} placeholder="🔎 filtrar…" style={css(inputStyle + 'padding:10px 12px;min-width:220px;')} />
                  <button onClick={v.newAluno} style={css('border:1px solid var(--accent,#2563eb);background:var(--accent,#2563eb);color:#fff;padding:10px 16px;border-radius:9px;cursor:pointer;font-size:13.5px;font-weight:600;')}>＋ Novo aluno</button>
                </div>
              </div>
              <section style={css(card + 'overflow:hidden;')}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={css(thPlain('left'))}>Nome</th>
                      <th style={css(thPlain('left'))}>E-mail</th>
                      <th style={css(thPlain('left'))}>Matrícula</th>
                      <th style={css(thPlain('left'))}>ID</th>
                      <th style={css(thPlain('right'))}>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.alunosRows.map((a, i) => (
                      <tr key={i} className="ce-row">
                        <td style={css('padding:14px 18px;border-bottom:1px solid var(--line);font-size:14.5px;font-weight:500;')}>{a.nome}</td>
                        <td style={css('padding:14px 18px;border-bottom:1px solid var(--line);font-size:14px;color:var(--muted);')}>{a.email}</td>
                        <td style={css("padding:14px 18px;border-bottom:1px solid var(--line);font-size:14px;font-family:'IBM Plex Mono',monospace;")}>{a.matricula}</td>
                        <td style={css("padding:14px 18px;border-bottom:1px solid var(--line);font-size:13px;font-family:'IBM Plex Mono',monospace;color:var(--muted);")}>{a.shortId}</td>
                        <td style={css('padding:10px 18px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap;')}>
                          <button onClick={a.onEdit} style={css('border:1px solid var(--line);background:var(--panel2);color:var(--txt);padding:7px 11px;border-radius:8px;cursor:pointer;font-size:13px;margin-right:6px;')}>✏️ Editar</button>
                          <button onClick={a.onDelete} style={css('border:1px solid color-mix(in srgb,var(--red) 40%,var(--line));background:transparent;color:var(--red);padding:7px 11px;border-radius:8px;cursor:pointer;font-size:13px;')}>🗑️</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {v.noAlunos && <div style={css('text-align:center;color:var(--muted);padding:34px 10px;font-size:14px;')}>Nenhum aluno encontrado.</div>}
              </section>
            </>
          )}

          {/* ===== CURSOS ===== */}
          {v.isCursos && (
            <>
              <div style={css('display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;')}>
                <div>
                  <h1 style={css('margin:0;font-size:26px;font-weight:700;letter-spacing:-.3px;')}>Cursos</h1>
                  <div style={css('font-size:13.5px;color:var(--muted);margin-top:4px;')}>CRUD · keyspace <code style={css("font-family:'IBM Plex Mono',monospace;")}>cursos_ks.cursos</code> · {v.cuCount} registros</div>
                </div>
                <div style={css('display:flex;gap:10px;align-items:center;')}>
                  <input type="search" value={v.cuSearch} onInput={v.onCuSearch} onChange={v.onCuSearch} placeholder="🔎 filtrar…" style={css(inputStyle + 'padding:10px 12px;min-width:220px;')} />
                  <button onClick={v.newCurso} style={css('border:1px solid var(--accent,#2563eb);background:var(--accent,#2563eb);color:#fff;padding:10px 16px;border-radius:9px;cursor:pointer;font-size:13.5px;font-weight:600;')}>＋ Novo curso</button>
                </div>
              </div>
              <section style={css(card + 'overflow:hidden;')}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={css(thPlain('left'))}>Nome</th>
                      <th style={css(thPlain('right'))}>Carga horária</th>
                      <th style={css(thPlain('left'))}>ID</th>
                      <th style={css(thPlain('right'))}>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.cursosRows.map((c2, i) => (
                      <tr key={i} className="ce-row">
                        <td style={css('padding:14px 18px;border-bottom:1px solid var(--line);font-size:14.5px;font-weight:500;')}>{c2.nome}</td>
                        <td style={css("padding:14px 18px;border-bottom:1px solid var(--line);font-size:14px;text-align:right;font-family:'IBM Plex Mono',monospace;")}>{c2.carga}</td>
                        <td style={css("padding:14px 18px;border-bottom:1px solid var(--line);font-size:13px;font-family:'IBM Plex Mono',monospace;color:var(--muted);")}>{c2.shortId}</td>
                        <td style={css('padding:10px 18px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap;')}>
                          <button onClick={c2.onEdit} style={css('border:1px solid var(--line);background:var(--panel2);color:var(--txt);padding:7px 11px;border-radius:8px;cursor:pointer;font-size:13px;margin-right:6px;')}>✏️ Editar</button>
                          <button onClick={c2.onDelete} style={css('border:1px solid color-mix(in srgb,var(--red) 40%,var(--line));background:transparent;color:var(--red);padding:7px 11px;border-radius:8px;cursor:pointer;font-size:13px;')}>🗑️</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {v.noCursos && <div style={css('text-align:center;color:var(--muted);padding:34px 10px;font-size:14px;')}>Nenhum curso encontrado.</div>}
              </section>
            </>
          )}
        </main>

        {/* ===== MODAL: TESTE DE CARGA ===== */}
        {v.showLoad && (
          <div onClick={v.closeModalBg} style={css('position:fixed;inset:0;background:color-mix(in srgb,#000 55%,transparent);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px;')}>
            <div onClick={(e) => e.stopPropagation()} style={css('background:var(--panel);border:1px solid var(--line);border-radius:18px;width:100%;max-width:580px;box-shadow:0 24px 80px rgba(0,0,0,.5);overflow:hidden;')}>
              <div style={css('padding:18px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;')}><h3 style={css('margin:0;font-size:18px;font-weight:700;')}>⚡ Teste de carga</h3></div>
              <div style={css('padding:22px 24px;font-size:14px;line-height:1.6;')}>
                {v.loadIdle && (
                  <>
                    <p style={css('margin:0 0 14px;')}>Dispara, <b>por serviço</b>, <b>100 GET + 50 POST</b> (intercalando <b>2 GET : 1 POST</b>) passando pelo gateway, ritmado em <b>~12 req/s</b> (≈ 25 s no total).</p>
                    <div style={css('background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px 18px;')}>
                      <b style={css('font-size:13.5px;')}>Onde acompanhar:</b>
                      <ul style={css('margin:10px 0 0;padding-left:20px;color:var(--muted);')}>
                        <li style={css('margin:5px 0;')}>Os <b style={css('color:var(--txt);')}>gráficos</b> sobem ao vivo (gateway, serviços e 503).</li>
                        <li style={css('margin:5px 0;')}>A <b style={css('color:var(--txt);')}>tabela de roteamento</b> enche com os tempos em ms.</li>
                        <li style={css('margin:5px 0;')}>No <b style={css('color:var(--txt);')}>Dozzle</b> você vê os logs crus de cada container.</li>
                      </ul>
                    </div>
                    <p style={css('color:var(--muted);font-size:12.5px;margin:14px 0 0;')}>O gateway limita a 10 req/s — alguns <b>503</b> aparecem, demonstrando o rate limit sob carga.</p>
                  </>
                )}
                {v.loadRunning && (
                  <>
                    <p style={css('display:inline-flex;align-items:center;gap:8px;margin:0 0 12px;color:var(--green);')}><span style={css(v.liveDotStyle)} /> rodando o teste… acompanhe os gráficos.</p>
                    <div style={css("font-family:'IBM Plex Mono',monospace;font-size:12.5px;background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:14px;white-space:pre-wrap;")}>{v.loadLog}</div>
                  </>
                )}
                {v.loadDone && (
                  <>
                    <p style={css('margin:0 0 14px;')}>✅ Teste concluído em <b>{v.loadResult.duration}</b> ({v.loadResult.rps} req/s).</p>
                    <div style={css('display:flex;gap:12px;flex-wrap:wrap;')}>
                      <div style={css('flex:1;min-width:120px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px 16px;')}><div style={css('font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;')}>{v.loadResult.total}</div><div style={css('font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-top:2px;')}>requisições</div></div>
                      <div style={css('flex:1;min-width:120px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px 16px;')}><div style={css('font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--green);')}>{v.loadResult.ok}</div><div style={css('font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-top:2px;')}>sucesso 2xx</div></div>
                      <div style={css('flex:1;min-width:120px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px 16px;')}><div style={css('font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--red);')}>{v.loadResult.blocked}</div><div style={css('font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-top:2px;')}>503 rate-limit</div></div>
                    </div>
                  </>
                )}
              </div>
              <div style={css('padding:16px 24px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end;')}>
                {v.loadDone && <button onClick={v.closeLoad} style={css('border:1px solid var(--accent,#2563eb);background:var(--accent,#2563eb);color:#fff;padding:9px 18px;border-radius:9px;cursor:pointer;font-size:13.5px;font-weight:600;')}>Fechar</button>}
                {v.loadIdle && (
                  <>
                    <button onClick={v.closeLoad} style={css('border:1px solid var(--line);background:transparent;color:var(--muted);padding:9px 18px;border-radius:9px;cursor:pointer;font-size:13.5px;')}>Cancelar</button>
                    <button onClick={v.runLoad} style={css('border:1px solid var(--accent,#2563eb);background:var(--accent,#2563eb);color:#fff;padding:9px 18px;border-radius:9px;cursor:pointer;font-size:13.5px;font-weight:600;')}>▶ Executar agora</button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===== MODAL: FORMULÁRIO ===== */}
        {v.showForm && (
          <div onClick={v.closeModalBg} style={css('position:fixed;inset:0;background:color-mix(in srgb,#000 55%,transparent);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px;')}>
            <div onClick={(e) => e.stopPropagation()} style={css('background:var(--panel);border:1px solid var(--line);border-radius:18px;width:100%;max-width:520px;box-shadow:0 24px 80px rgba(0,0,0,.5);overflow:hidden;')}>
              <div style={css('padding:18px 24px;border-bottom:1px solid var(--line);')}><h3 style={css('margin:0;font-size:18px;font-weight:700;')}>{v.formTitle}</h3></div>
              <div style={css('padding:22px 24px;')}>
                {v.formFields.map((f) => (
                  <div key={f.key} style={css('margin-bottom:16px;')}>
                    <label style={css('display:block;font-size:11.5px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px;font-weight:600;')}>{f.label}</label>
                    <input type={f.type} value={f.value} onInput={f.onInput} onChange={f.onInput} placeholder={f.placeholder} style={css('width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--txt);padding:11px 13px;border-radius:9px;font-size:14.5px;font-family:inherit;')} />
                    {f.hasError && <div style={css('color:var(--red);font-size:12px;margin-top:5px;')}>{f.error}</div>}
                  </div>
                ))}
              </div>
              <div style={css('padding:16px 24px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end;')}>
                <button onClick={v.closeForm} style={css('border:1px solid var(--line);background:transparent;color:var(--muted);padding:9px 18px;border-radius:9px;cursor:pointer;font-size:13.5px;')}>Cancelar</button>
                <button onClick={v.saveForm} style={css('border:1px solid var(--accent,#2563eb);background:var(--accent,#2563eb);color:#fff;padding:9px 18px;border-radius:9px;cursor:pointer;font-size:13.5px;font-weight:600;')}>Salvar</button>
              </div>
            </div>
          </div>
        )}

        {/* ===== MODAL: CONFIRMAR EXCLUSÃO ===== */}
        {v.showConfirm && (
          <div onClick={v.closeModalBg} style={css('position:fixed;inset:0;background:color-mix(in srgb,#000 55%,transparent);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px;')}>
            <div onClick={(e) => e.stopPropagation()} style={css('background:var(--panel);border:1px solid var(--line);border-radius:18px;width:100%;max-width:440px;box-shadow:0 24px 80px rgba(0,0,0,.5);overflow:hidden;')}>
              <div style={css('padding:18px 24px;border-bottom:1px solid var(--line);')}><h3 style={css('margin:0;font-size:18px;font-weight:700;')}>Confirmar exclusão</h3></div>
              <div style={css('padding:22px 24px;font-size:14.5px;line-height:1.55;')}>Excluir <b>{v.delName}</b>? Esta ação não pode ser desfeita.</div>
              <div style={css('padding:16px 24px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end;')}>
                <button onClick={v.closeConfirm} style={css('border:1px solid var(--line);background:transparent;color:var(--muted);padding:9px 18px;border-radius:9px;cursor:pointer;font-size:13.5px;')}>Cancelar</button>
                <button onClick={v.doDelete} style={css('border:1px solid var(--red);background:var(--red);color:#fff;padding:9px 18px;border-radius:9px;cursor:pointer;font-size:13.5px;font-weight:600;')}>Excluir</button>
              </div>
            </div>
          </div>
        )}

        {/* ===== TOAST ===== */}
        {v.showToast && <div style={css(v.toastStyle)}>{v.toastMsg}</div>}
      </div>
    )
  }
}
