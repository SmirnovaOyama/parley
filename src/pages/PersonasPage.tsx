import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { Switch } from "../components/Controls.tsx";
import { DangerRow } from "../components/DangerRow.tsx";
import { Advisory, EmptyState, Spinner } from "../components/Feedback.tsx";
import { LineArea, LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, type Persona } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";
import { ABOUT_HINT, charsLeft, instructionsSummary, MAX_INSTRUCTION_CHARS, STYLE_HINT } from "../lib/instructions.ts";
import { useSlideNavigate } from "../lib/slide.ts";

type PersonaList = { personas: Persona[]; max: number };

/** Every persona (/settings/personas): up to five, one of which new chats can start as. */
export function PersonasPage() {
  const slideTo = useSlideNavigate();
  const [list, setList] = useState<PersonaList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<PersonaList>("/personas").then(setList, (err) => setError((err as Error).message));
  }, []);

  const full = !!list && list.personas.length >= list.max;
  const add = () => slideTo("/settings/personas/new", "forward");

  return (
    <>
      <PageHeader
        title={t("Personas")}
        subtitle={t("Who you are to the AI, and how it should answer")}
        back={{ label: t("Settings"), to: "/settings" }}
        trailing={
          // Always there, so the header never shifts; it rests once there are five.
          <button type="button" className="btn-primary" onClick={add} disabled={!list || full}>
            <Icon name="plus" size={20} />
            {t("New")}
          </button>
        }
      />
      <div className="oy-page-column page-body">
        {error ? (
          <Advisory>{error}</Advisory>
        ) : !list ? (
          <Spinner />
        ) : list.personas.length === 0 ? (
          <EmptyState
            doodle="persona"
            title={t("No personas yet")}
            action={
              <button type="button" className="btn-primary" onClick={add}>
                {t("Make a persona")}
              </button>
            }
          >
            {t("Make up to five, say one for work and one for study, each with what the AI should know about you and how it should answer")}
          </EmptyState>
        ) : (
          <>
            <div className="oy-section">
              {list.personas.map((p) => (
                <SlideLink key={p.id} className="oy-row" to={`/settings/personas/${p.id}`} direction="forward">
                  <Icon name="user" size={20} />
                  <div className="text">
                    <p className="title truncate">
                      {p.name}
                      {p.forNewChats && <span className="tag is-accent">{t("New chats")}</span>}
                    </p>
                    <div className="desc truncate">{instructionsSummary(p) ?? t("Nothing written yet")}</div>
                  </div>
                  <Icon name="chevron-right" size={18} className="chevron" />
                </SlideLink>
              ))}
            </div>
            <p className="footnote">
              {full
                ? t("That's five, the most you can have. Delete one to make another")
                : t("New chats start as the one marked for them. A chat's settings can switch it to another")}
            </p>
          </>
        )}
      </div>
    </>
  );
}

/** A new persona (/settings/personas/new), or one's name and words (/settings/personas/:id). */
export function PersonaFormPage() {
  const { id = "new" } = useParams();
  const adding = id === "new";
  const slideTo = useSlideNavigate();
  const [persona, setPersona] = useState<Persona | null>(null);
  const [ready, setReady] = useState(false);
  const [full, setFull] = useState(false);
  const [name, setName] = useState("");
  const [aboutMe, setAboutMe] = useState("");
  const [answerStyle, setAnswerStyle] = useState("");
  const [forNewChats, setForNewChats] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReady(false);
    if (adding) {
      // The first persona is the one new chats start as, unless that's switched off.
      api.get<PersonaList>("/personas").then(
        (r) => {
          setFull(r.personas.length >= r.max);
          setForNewChats(r.personas.length === 0);
          setReady(true);
        },
        (err) => setLoadError((err as Error).message),
      );
      return;
    }
    api.get<{ persona: Persona }>(`/personas/${id}`).then(
      (r) => {
        setPersona(r.persona);
        setName(r.persona.name);
        setAboutMe(r.persona.aboutMe);
        setAnswerStyle(r.persona.answerStyle);
        setForNewChats(r.persona.forNewChats);
        setReady(true);
      },
      (err) => setLoadError((err as Error).message),
    );
  }, [id, adding]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, aboutMe, answerStyle, forNewChats };
      if (adding) await api.post("/personas", body);
      else await api.patch(`/personas/${id}`, body);
      slideTo("/settings/personas", "back");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api.del(`/personas/${id}`);
    slideTo("/settings/personas", "back", { replace: true });
  };

  return (
    <>
      <PageHeader title={adding ? t("New persona") : (persona?.name ?? t("Persona"))} back={{ label: t("Personas"), to: "/settings/personas" }} />
      <div className="oy-page-column page-body">
        {loadError ? (
          <Advisory>{loadError}</Advisory>
        ) : !ready ? (
          <Spinner />
        ) : adding && full ? (
          <Advisory>{t("You have five personas, the most there can be. Delete one to make another")}</Advisory>
        ) : (
          <>
            <form className="form-page" onSubmit={save}>
              <LineField id="persona-name" label={t("Name")} value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
              <LineArea
                id="persona-about"
                label={t("What should the AI know about you?")}
                value={aboutMe}
                maxLength={MAX_INSTRUCTION_CHARS}
                onChange={(e) => setAboutMe(e.target.value)}
                hint={charsLeft(aboutMe, ABOUT_HINT)}
              />
              <LineArea
                id="persona-style"
                label={t("How should it answer?")}
                value={answerStyle}
                maxLength={MAX_INSTRUCTION_CHARS}
                onChange={(e) => setAnswerStyle(e.target.value)}
                hint={charsLeft(answerStyle, STYLE_HINT)}
              />
              <div className="oy-section is-plain">
                <div className="oy-row">
                  <Icon name="compose" size={20} />
                  <div className="text">
                    <label className="title" htmlFor="persona-new-chats">
                      {t("Start new chats as this persona")}
                    </label>
                  </div>
                  <Switch id="persona-new-chats" checked={forNewChats} onChange={setForNewChats} />
                </div>
              </div>
              <p className="panel-note">{t("A chat keeps the words it started with, so a change here reaches new chats")}</p>
              {error && <Advisory>{error}</Advisory>}
              <div className="form-page-actions">
                <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!name.trim()}>
                  {adding ? t("Make persona") : t("Save")}
                </BusyButton>
                <SlideLink to="/settings/personas" direction="back" className="btn-secondary">
                  {t("Cancel")}
                </SlideLink>
              </div>
            </form>
            {!adding && (
              <div className="settings-danger">
                <DangerRow label={t("Delete this persona")} confirmLabel={t("Delete this persona? Chats started as it keep its words")} onConfirm={remove} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
