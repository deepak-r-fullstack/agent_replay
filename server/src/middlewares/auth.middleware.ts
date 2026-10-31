import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { UserRole } from "../constants";
import { ForbiddenError, UnauthorizedError } from "../helpers/errors";
import { isUserActive, verifyToken } from "../services/auth/auth.service";
import { User } from "../models/user.model";

// The signed-in person (from the JWT) is kept on res.locals,
// like res.locals.documentToDelete in the NueAssist services.

export interface RequestUser {
  id: string;
  workspaceId: Types.ObjectId;
  role: UserRole;
  name: string;
  email: string;
}

export function getRequestUser(res: Response): RequestUser {
  const user = res.locals.user as RequestUser | undefined;
  if (!user) throw new UnauthorizedError();
  return user;
}

export async function authenticateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) throw new UnauthorizedError("Please sign in.");

    const payload = verifyToken(token);
    if (!Types.ObjectId.isValid(payload.sub) || !Types.ObjectId.isValid(payload.workspaceId)) throw new UnauthorizedError();

    // The token only proves who signed in earlier. The person's current record decides what they may do now,
    // so turning someone off, or changing their role, takes effect on their very next request.
    const user = await User.findOne({ _id: payload.sub, workspaceId: payload.workspaceId }).lean();
    if (!user) throw new UnauthorizedError();
    if (!isUserActive(user)) throw new UnauthorizedError("This account has been turned off. Please ask the owner of your workspace.");

    res.locals.user = {
      id: String(user._id),
      workspaceId: user.workspaceId as Types.ObjectId,
      role: user.role,
      name: user.name,
      email: user.email,
    } satisfies RequestUser;
    next();
  } catch (err) {
    next(err);
  }
}

export function authorizeRoles(...roles: UserRole[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const user = getRequestUser(res);
    if (!roles.includes(user.role)) return next(new ForbiddenError("Your role can only look at this. Ask a workspace owner or developer."));
    return next();
  };
}
