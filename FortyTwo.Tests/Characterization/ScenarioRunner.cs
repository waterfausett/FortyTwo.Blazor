using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using FortyTwo.Entity;
using FortyTwo.Server.Services;
using FortyTwo.Shared.DTO;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;
using Microsoft.EntityFrameworkCore;

namespace FortyTwo.Tests.Characterization
{
    // Drives the real MatchService/MatchValidationService/DatabaseContext
    // (EF InMemory provider — no real Postgres needed) and snapshots the
    // Match after every action. A new MatchService is constructed per
    // action with the UserId of whichever player is acting, mirroring
    // how DI scopes MatchService per-request in production.
    public class ScenarioRunner
    {
        private readonly DatabaseContext _context;
        private readonly FixedOrderDominoService _dominoService;
        private readonly List<object> _steps = new();
        private readonly string _fixtureName;

        public ScenarioRunner(List<(int Top, int Bottom)> dealOrder, string fixtureName)
        {
            var options = new DbContextOptionsBuilder<DatabaseContext>()
                .UseInMemoryDatabase(Guid.NewGuid().ToString())
                .Options;
            _context = new DatabaseContext(options);
            _dominoService = new FixedOrderDominoService(dealOrder);
            _fixtureName = fixtureName;
        }

        private MatchService ServiceFor(string userId)
            => new MatchService(_context, (UserId)userId, new MatchValidationService(), _dominoService);

        public async Task<Guid> CreateAsync(string firstPlayerId)
        {
            var match = await ServiceFor(firstPlayerId).CreateAsync();
            await SnapshotAsync("create", match.Id);
            return match.Id;
        }

        public async Task AddPlayerAsync(Guid matchId, string playerId, Teams team)
        {
            await ServiceFor(playerId).AddPlayerAsync(matchId, team);
            await SnapshotAsync("addPlayer", matchId);
        }

        public async Task ReadyUpAsync(Guid matchId, string playerId)
        {
            await ServiceFor(playerId).PatchPlayerAsync(matchId, new PlayerPatchRequest { Ready = true });
            await SnapshotAsync("readyUp", matchId);
        }

        public async Task BidAsync(Guid matchId, string playerId, Bid bid)
        {
            await ServiceFor(playerId).BidAsync(matchId, bid);
            await SnapshotAsync("bid", matchId);
        }

        public async Task SetTrumpAsync(Guid matchId, string playerId, Suit suit)
        {
            await ServiceFor(playerId).SetTrumpForCurrentGameAsync(matchId, suit);
            await SnapshotAsync("setTrump", matchId);
        }

        public async Task PlayDominoAsync(Guid matchId, string playerId, int top, int bottom)
        {
            await ServiceFor(playerId).PlayDominoAsync(matchId, new Domino(top, bottom));
            await SnapshotAsync("playDomino", matchId);
        }

        private async Task SnapshotAsync(string action, Guid matchId)
        {
            var match = await _context.Matches.AsNoTracking().Include(x => x.Players)
                .FirstAsync(x => x.Id == matchId);

            var json = JsonSerializer.Serialize(match, new JsonSerializerOptions
            {
                WriteIndented = true,
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles
            });

            _steps.Add(new { action, state = JsonDocument.Parse(json).RootElement.Clone() });
        }

        public void WriteFixture()
        {
            var dir = Path.Combine(AppContext.BaseDirectory, "Characterization", "Fixtures");
            Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(_steps, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(Path.Combine(dir, $"{_fixtureName}.json"), json);
            Console.WriteLine($"Wrote fixture: {Path.Combine(dir, $"{_fixtureName}.json")}");
        }
    }
}
