/** HTTP routes của module Threads (/api/threads/*). */
const send = (reply, result) => reply.code(result.ok ? 200 : 409).send(result);

export default async function threadsRoutes(app, _ctx, svc) {
  app.get("/api/threads/jobs", async (req) => ({
    ok: true,
    jobs: svc.listJobs(req.query?.limit),
  }));

  app.get("/api/threads/jobs/:id", async (req) => ({
    ok: true,
    job: svc.getJob(req.params.id),
  }));

  app.delete("/api/threads/jobs/:id", async (req) => svc.deleteJob(req.params.id));

  app.post("/api/threads/video", async (req, reply) =>
    send(reply, svc.startVideoThreads(req.body || {})),
  );

  app.post("/api/threads/reup", async (req, reply) =>
    send(reply, svc.startReupThreads(req.body || {})),
  );

  app.post("/api/threads/scrape", async (req, reply) =>
    send(reply, svc.scrapePost(req.body || {})),
  );
}
