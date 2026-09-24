import { useCallback, useEffect, useState } from "react";

import { onSync } from "../../app/syncAgent";
import { asConversationError } from "../../lib/conversations";
import { teamBoard, type Board } from "../../lib/teams";

/**
 * One team's board, read from this device and read again after every sync.
 *
 * Nothing is fetched here. The sync agent pulls and decrypts; this only folds
 * what the store now holds, which is cheap enough to do on every pass.
 */
export function useTeamBoard(teamId: string): {
  board: Board | null;
  problem: string | null;
  reload: () => Promise<void>;
} {
  const [board, setBoard] = useState<Board | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoard(await teamBoard(teamId));
      setProblem(null);
    } catch (error) {
      setProblem(asConversationError(error).message);
    }
  }, [teamId]);

  useEffect(() => {
    setBoard(null);
    void reload();
    return onSync(() => void reload());
  }, [reload]);

  return { board, problem, reload };
}
