import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type ConversationSummary, type Instructions, type Project, type User } from "./api.ts";

type SessionValue = {
  user: User | null;
  loading: boolean;
  refreshUser: () => Promise<void>;
  signOut: () => Promise<void>;
  conversations: ConversationSummary[];
  refreshConversations: () => Promise<void>;
  /** Puts a conversation at the top of the list straight away, before the server confirms. */
  touchConversation: (c: ConversationSummary) => void;
  /** Instructions for the chat about to start, set on its settings page; null means the defaults in Settings. */
  newChatInstructions: Instructions | null;
  setNewChatInstructions: (next: Instructions | null) => void;
  /** Knowledge bases picked for the chat about to start. */
  newChatKnowledge: string[];
  setNewChatKnowledge: (next: string[]) => void;
  /** The person's projects, newest activity first. */
  projects: Project[];
  refreshProjects: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [newChatInstructions, setNewChatInstructions] = useState<Instructions | null>(null);
  const [newChatKnowledge, setNewChatKnowledge] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const refreshUser = useCallback(async () => {
    try {
      const { user } = await api.get<{ user: User }>("/auth/me");
      setUser(user);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations } = await api.get<{ conversations: ConversationSummary[] }>("/conversations");
      setConversations(conversations);
    } catch {
      // The list can wait for the next refresh.
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const { projects } = await api.get<{ projects: Project[] }>("/projects");
      setProjects(projects);
    } catch {
      // The list can wait for the next refresh.
    }
  }, []);

  const touchConversation = useCallback((c: ConversationSummary) => {
    setConversations((list) => [{ ...list.find((x) => x.id === c.id), ...c }, ...list.filter((x) => x.id !== c.id)]);
  }, []);

  const signOut = useCallback(async () => {
    await api.post("/auth/logout").catch(() => {});
    setUser(null);
    setConversations([]);
    setProjects([]);
    setNewChatInstructions(null);
    setNewChatKnowledge([]);
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  useEffect(() => {
    if (!user) return;
    void refreshConversations();
    void refreshProjects();
  }, [user, refreshConversations, refreshProjects]);

  // While any chat has a reply being written (here, in another tab, or one left running), check
  // back every few seconds so its spinner stops when the reply is saved.
  const anyGenerating = conversations.some((c) => c.generating);
  useEffect(() => {
    if (!anyGenerating) return;
    const timer = setInterval(() => void refreshConversations(), 3000);
    return () => clearInterval(timer);
  }, [anyGenerating, refreshConversations]);

  return (
    <SessionContext
      value={{
        user,
        loading,
        refreshUser,
        signOut,
        conversations,
        refreshConversations,
        touchConversation,
        newChatInstructions,
        setNewChatInstructions,
        newChatKnowledge,
        setNewChatKnowledge,
        projects,
        refreshProjects,
      }}
    >
      {children}
    </SessionContext>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
