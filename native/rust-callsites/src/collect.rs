//! The collector: after analysis, one NDJSON row per call site of the local crate
//! (SPEC §3), with the drop rules of §3/§4.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use rustc_hir::{
    Expr, ExprKind, QPath,
    def::{DefKind, Res},
    intravisit::{self, Visitor},
};
use rustc_middle::ty::{self, Instance, TyCtxt, TypeVisitableExt, TypeckResults};
use rustc_span::{
    ExpnKind, FileName, Span,
    def_id::{DefId, LOCAL_CRATE, LocalDefId},
};

use crate::Args;

pub(crate) struct Callbacks {
    args: Args,
    /// cargo's `-C extra-filename` (e.g. `-4fb7abc2c4382f18`): `<crate><suffix>` is the unit's
    /// rmeta stem, which is how the CLI maps cargo's compiler-artifact list onto unit files.
    unit_suffix: String,
}

impl Callbacks {
    pub(crate) fn new(args: Args, unit_suffix: String) -> Self {
        Callbacks { args, unit_suffix }
    }
}

/// Write `bytes` to `path` via a sibling temp file + rename, so a killed driver never
/// leaves a truncated unit file behind (the CLI's GC deletes stray `.tmp` files).
fn write_atomic(
    path: &Path,
    write: impl FnOnce(&mut dyn Write) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    {
        let mut f = std::io::BufWriter::new(fs::File::create(&tmp)?);
        write(&mut f)?;
        f.flush()?;
    }
    fs::rename(&tmp, path)
}

impl rustc_driver::Callbacks for Callbacks {
    fn after_analysis<'tcx>(
        &mut self,
        _compiler: &rustc_interface::interface::Compiler,
        tcx: TyCtxt<'tcx>,
    ) -> rustc_driver::Compilation {
        rustc_middle::ty::print::with_no_trimmed_paths!(self.collect(tcx))
    }
}

impl Callbacks {
    fn collect<'tcx>(&mut self, tcx: TyCtxt<'tcx>) -> rustc_driver::Compilation {
        let started = std::time::Instant::now();
        let mut rows: Vec<serde_json::Value> = Vec::new();
        let mut stats: HashMap<&'static str, u64> = HashMap::new();
        let mut lines = LineCache::default();
        let root = PathBuf::from(&self.args.project_root);
        for owner in tcx.hir_body_owners() {
            // `#[derive]` output carries the user's field/attribute spans, not an
            // expansion context: drop it by the enclosing impl's marker instead.
            let derived = tcx.opt_parent(owner.to_def_id()).is_some_and(|p| {
                matches!(tcx.def_kind(p), DefKind::Impl { .. }) && tcx.is_automatically_derived(p)
            });
            if derived {
                *stats.entry("drop.deriveBody").or_default() += 1;
                continue;
            }
            let tq = std::time::Instant::now();
            let typeck = tcx.typeck(owner);
            *stats.entry("us.typeckQuery").or_default() += tq.elapsed().as_micros() as u64;
            let body = tcx.hir_body_owned_by(owner);
            let mut v = CallVisitor {
                tcx,
                owner,
                typeck,
                root: &root,
                rows: &mut rows,
                stats: &mut stats,
                lines: &mut lines,
            };
            let tv = std::time::Instant::now();
            v.visit_body(body);
            *stats.entry("us.visitBody").or_default() += tv.elapsed().as_micros() as u64;
        }
        let krate = tcx.crate_name(LOCAL_CRATE);
        let stable = tcx.stable_crate_id(LOCAL_CRATE);
        let path = Path::new(&self.args.units_dir).join(format!(
            "{}-{:016x}.ndjson",
            krate,
            stable.as_u64()
        ));
        write_atomic(&path, |f| {
            for r in &rows {
                writeln!(f, "{r}")?;
            }
            Ok(())
        })
        .expect("write unit ndjson");
        let mut stats_sorted: Vec<_> = stats.into_iter().collect();
        stats_sorted.sort();
        // Written after the rows: an `.ndjson` without its `.stats.json` is incomplete and GC'd.
        let stats_json = serde_json::json!({
            "crate": krate.to_string(),
            "unit": format!("{krate}{}", self.unit_suffix),
            "rows": rows.len(),
            "ms": started.elapsed().as_millis() as u64,
            "stats": stats_sorted,
        });
        write_atomic(&path.with_extension("stats.json"), |f| {
            write!(f, "{stats_json}")
        })
        .expect("write unit stats");
        rustc_driver::Compilation::Continue
    }
}

#[derive(Default)]
struct LineCache {
    files: HashMap<PathBuf, Option<Vec<String>>>,
    canon: HashMap<PathBuf, PathBuf>,
}

impl LineCache {
    /// utf16 column of the `char_col`-th char of 1-based `line`.
    fn utf16_col(&mut self, file: &Path, line: usize, char_col: usize) -> Option<usize> {
        let entry = self.files.entry(file.to_path_buf()).or_insert_with(|| {
            fs::read_to_string(file)
                .ok()
                .map(|t| t.split('\n').map(str::to_owned).collect())
        });
        let text = entry.as_ref()?.get(line.checked_sub(1)?)?;
        Some(text.chars().take(char_col).map(char::len_utf16).sum())
    }
}

struct CallVisitor<'a, 'tcx> {
    tcx: TyCtxt<'tcx>,
    owner: LocalDefId,
    typeck: &'tcx TypeckResults<'tcx>,
    root: &'a Path,
    rows: &'a mut Vec<serde_json::Value>,
    stats: &'a mut HashMap<&'static str, u64>,
    lines: &'a mut LineCache,
}

struct Pos {
    rel_path: String,
    line: usize,
    col_utf16: usize,
    in_root: bool,
}

impl<'a, 'tcx> CallVisitor<'a, 'tcx> {
    fn tick(&mut self, k: &'static str, t: std::time::Instant) {
        *self.stats.entry(k).or_default() += t.elapsed().as_micros() as u64;
    }

    fn bump(&mut self, k: &'static str) {
        *self.stats.entry(k).or_default() += 1;
    }

    fn pos(&mut self, span: Span) -> Option<Pos> {
        let sm = self.tcx.sess.source_map();
        let loc = sm.lookup_char_pos(span.lo());
        let local = match &loc.file.name {
            FileName::Real(real) => real.local_path()?.to_path_buf(),
            _ => return None,
        };
        let abs = match self.lines.canon.get(&local) {
            Some(a) => a.clone(),
            None => {
                let joined = if local.is_absolute() {
                    local.clone()
                } else {
                    std::env::current_dir().ok()?.join(&local)
                };
                let a = joined.canonicalize().unwrap_or(joined);
                self.lines.canon.insert(local, a.clone());
                a
            }
        };
        let col_utf16 = self.lines.utf16_col(&abs, loc.line, loc.col.0)?;
        let (rel_path, in_root) = match abs.strip_prefix(self.root) {
            Ok(rel) => (rel.to_string_lossy().into_owned(), true),
            Err(_) => (abs.to_string_lossy().into_owned(), false),
        };
        Some(Pos {
            rel_path,
            line: loc.line,
            col_utf16,
            in_root,
        })
    }

    fn def_kind_name(&self, def_id: DefId) -> &'static str {
        match self.tcx.def_kind(def_id) {
            DefKind::Fn => "fn",
            DefKind::AssocFn => "assocFn",
            DefKind::Ctor(..) => "ctor",
            DefKind::Closure => "closure",
            DefKind::Static { .. } => "static",
            DefKind::Const { .. } | DefKind::AssocConst { .. } => "const",
            _ => "other",
        }
    }

    fn emit(
        &mut self,
        call_kind: &'static str,
        expr: &'tcx Expr<'tcx>,
        name_span: Span,
        def_id: DefId,
    ) {
        let tcx = self.tcx;
        // Macro handling: a name token the user wrote (macro ARGUMENT) keeps a root
        // context; a name token the macro body produced is from_expansion.
        let (origin, macro_name, site) = if name_span.from_expansion() {
            let data = name_span.ctxt().outer_expn_data();
            match data.kind {
                ExpnKind::Desugaring(_) => {
                    self.bump("drop.desugaring");
                    return;
                }
                ExpnKind::Macro(_, name) => {
                    ("macro", Some(name.to_string()), name_span.source_callsite())
                }
                _ => {
                    self.bump("drop.otherExpansion");
                    return;
                }
            }
        } else {
            ("source", None, name_span)
        };
        let t0 = std::time::Instant::now();
        let Some(pos) = self.pos(site) else {
            self.bump("drop.noPosition");
            return;
        };
        if !pos.in_root {
            self.bump("drop.callerOutsideRoot");
            return;
        }
        self.tick("us.sitePos", t0);
        let t1 = std::time::Instant::now();
        let args = self.typeck.node_args(expr.hir_id);
        let (trait_path, impl_self) = (
            tcx.trait_of_assoc(def_id).map(|t| tcx.def_path_str(t)),
            tcx.impl_of_assoc(def_id).map(|i| {
                tcx.type_of(i)
                    .instantiate_identity()
                    .skip_normalization()
                    .to_string()
            }),
        );
        // Monomorphic dispatch: a trait method whose receiver type is concrete
        // resolves to the impl item the call actually runs.
        let mut resolved: Option<DefId> = None;
        if tcx.trait_of_assoc(def_id).is_some() && !args.has_infer() && !args.references_error() {
            let typing_env = ty::TypingEnv::post_analysis(tcx, self.owner.to_def_id());
            let args = tcx.erase_and_anonymize_regions(args);
            if let Ok(Some(inst)) = Instance::try_resolve(tcx, typing_env, def_id, args) {
                if inst.def_id() != def_id {
                    resolved = Some(inst.def_id());
                    self.bump("trait.resolvedToImpl");
                } else {
                    self.bump("trait.unresolved");
                }
            } else {
                self.bump("trait.resolveError");
            }
        }
        self.tick("us.traitAndResolve", t1);
        let t2 = std::time::Instant::now();
        let target = resolved.unwrap_or(def_id);
        let def_pos = tcx
            .def_ident_span(target)
            .or_else(|| Some(tcx.def_span(target)))
            .and_then(|s| self.pos(s));
        self.tick("us.defPos", t2);
        let t3 = std::time::Instant::now();
        let in_project = def_pos.as_ref().map_or(false, |p| p.in_root);
        self.bump(if in_project {
            "callee.inProject"
        } else {
            "callee.external"
        });
        self.bump(if origin == "macro" {
            "origin.macro"
        } else {
            "origin.source"
        });
        let row = serde_json::json!({
            "relPath": pos.rel_path,
            "line": pos.line,
            "col": pos.col_utf16,
            "origin": origin,
            "macro": macro_name,
            "callKind": call_kind,
            "callee": tcx.def_path_str(def_id),
            "calleeCrate": tcx.crate_name(def_id.krate).to_string(),
            "defKind": self.def_kind_name(def_id),
            "traitPath": trait_path,
            "implSelfType": impl_self,
            "resolvedImpl": resolved.map(|r| tcx.def_path_str(r)),
            "implIsDerived": resolved
                .and_then(|r| tcx.impl_of_assoc(r))
                .is_some_and(|i| tcx.is_automatically_derived(i)),
            "inProject": in_project,
            "defRelPath": def_pos.as_ref().filter(|p| p.in_root).map(|p| p.rel_path.clone()),
            "defLine": def_pos.as_ref().filter(|p| p.in_root).map(|p| p.line),
        });
        self.tick("us.rowStrings", t3);
        self.rows.push(row);
    }
}

impl<'a, 'tcx> Visitor<'tcx> for CallVisitor<'a, 'tcx> {
    fn visit_expr(&mut self, expr: &'tcx Expr<'tcx>) {
        match expr.kind {
            ExprKind::MethodCall(segment, ..) => {
                match self.typeck.type_dependent_def_id(expr.hir_id) {
                    Some(def_id) => self.emit("method", expr, segment.ident.span, def_id),
                    None => self.bump("drop.methodUnresolved"),
                }
            }
            ExprKind::Call(callee, _) => {
                if let ExprKind::Path(ref qpath) = callee.kind {
                    let name_span = match qpath {
                        QPath::Resolved(_, path) => path.segments.last().map(|s| s.ident.span),
                        QPath::TypeRelative(_, seg) => Some(seg.ident.span),
                    };
                    match (self.typeck.qpath_res(qpath, callee.hir_id), name_span) {
                        (Res::Def(_, def_id), Some(span)) => {
                            self.emit("path", callee, span, def_id)
                        }
                        (Res::Local(_), _) => self.bump("drop.localCallee"),
                        (_, None) => self.bump("drop.langItemPath"),
                        _ => self.bump("drop.pathOther"),
                    }
                } else {
                    self.bump("drop.nonPathCallee");
                }
            }
            _ => {}
        }
        intravisit::walk_expr(self, expr);
    }
}
