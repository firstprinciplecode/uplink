import { Router, Request, Response } from "express";
import { makeError } from "../schemas/error";

interface AuthedRequest extends Request {
  user?: { id: string; role: "admin" | "user" };
}

export const meRouter = Router();

// GET /v1/me - returns current user info (id, role)
meRouter.get("/", (req: AuthedRequest, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
  }
  return res.json({ id: user.id, role: user.role || "user" });
});


