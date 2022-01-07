using FortyTwo.Entity;
using FortyTwo.Server.Services;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;
using FortyTwo.Shared.Services;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using NSubstitute;
using System;
using System.Linq;
using System.Threading.Tasks;
using Xunit;

namespace FortyTwo.Tests.Server.Services
{
    public abstract class SqliteTestBase : IDisposable
    {
        private SqliteConnection Connection { get; }
        private DbContextOptions<DatabaseContext> ContextOptions { get; }
        protected  DatabaseContext DatabaseContext { get; }

        protected SqliteTestBase()
        {
            Connection = new SqliteConnection("DataSource=:memory:");
            Connection.Open();

            ContextOptions = new DbContextOptionsBuilder<DatabaseContext>()
                            .UseSqlite(Connection)
                            .Options;

            DatabaseContext = new DatabaseContext(ContextOptions);
            DatabaseContext.Database.EnsureDeleted();
            DatabaseContext.Database.EnsureCreated();
        }

        public void Dispose()
        {
            DatabaseContext?.Dispose();
            Connection?.Dispose();
        }
    }

    public abstract class MatchServiceTestBase : SqliteTestBase
    {
        public async Task Seed(Guid id, Suit? trump = null, Trick trick = null, string currentPlayerId = null)
        {
            var match = new Entity.Models.Match(id);

            match.Players.Add(new Entity.Models.MatchPlayer
            {
                Id = 1,
                MatchId = id,
                PlayerId = "player1",
                Position = Positions.First
            });
            match.Players.Add(new Entity.Models.MatchPlayer
            {
                Id = 2,
                MatchId = id,
                PlayerId = "player2",
                Position = Positions.Second
            });
            match.Players.Add(new Entity.Models.MatchPlayer
            {
                Id = 3,
                MatchId = id,
                PlayerId = "player3",
                Position = Positions.Third
            });
            match.Players.Add(new Entity.Models.MatchPlayer
            {
                Id = 4,
                MatchId = id,
                PlayerId = "player4",
                Position = Positions.Fourth
            });

            match.CurrentGame.Hands.Add(new Hand
            {
                PlayerId = "player1",
                Team = Teams.TeamA
            });
            match.CurrentGame.Hands.Add(new Hand
            {
                PlayerId = "player2",
                Team = Teams.TeamB
            });
            match.CurrentGame.Hands.Add(new Hand
            {
                PlayerId = "player3",
                Team = Teams.TeamA
            });
            match.CurrentGame.Hands.Add(new Hand
            {
                PlayerId = "player4",
                Team = Teams.TeamB
            });

            if (trump.HasValue)
            {
                match.CurrentGame.Trump = trump;
            }

            if (!string.IsNullOrWhiteSpace(currentPlayerId))
            {
                match.CurrentGame.CurrentPlayerId = currentPlayerId;
            }

            if (trick != null)
            {
                match.CurrentGame.CurrentTrick = trick;
            }

            DatabaseContext.Matches.Add(match);

            await DatabaseContext.SaveChangesAsync();
        }
    }

    public class MatchServiceTests : MatchServiceTestBase
    {
        private readonly MatchService _service;
        private readonly IMatchValidationService _validationService;

        public MatchServiceTests()
        {
            _validationService = Substitute.For<IMatchValidationService>();
            var dominoService = Substitute.For<IDominoService>();
            _service = new MatchService(DatabaseContext, (UserId)"player1", _validationService, dominoService);
        }

        [Fact]
        public async Task PlayShouldProgressInOrder()
        {
            // Arrange
            Guid matchId = Guid.NewGuid();
            var currentTrick = new Trick()
            {
                PlayerId = "player4",
                Suit = Suit.Aces,
                Team = Teams.TeamB,
                Dominos = new Domino[4]
                {
                    new Domino(0, 1),
                    null,
                    null,
                    null
                }
            };

            await base.Seed(matchId, trump: Suit.Threes, trick: currentTrick, currentPlayerId: "player1");

            // Act
            await _service.PlayDominoAsync(matchId, new Domino(1, 1));

            // Assert
            var match = await DatabaseContext.Matches.FirstOrDefaultAsync(x => x.Id == matchId);
            Assert.NotNull(match);
            Assert.Equal("player2", match.CurrentGame.CurrentPlayerId);
            Assert.Equal(Teams.TeamA, match.CurrentGame.CurrentTrick.Team);
            Assert.Equal("player1", match.CurrentGame.CurrentTrick.PlayerId);
        }

        [Fact]
        public async Task WinnerOfTheTrickLeadsTheNext()
        {
            // Arrange
            Guid matchId = Guid.NewGuid();
            var currentTrick = new Trick()
            {
                PlayerId = "player2",
                Suit = Suit.Aces,
                Team = Teams.TeamB,
                Dominos = new Domino[4]
                {
                    new Domino(0, 1),
                    new Domino(1, 2),
                    new Domino(1, 6),
                    null
                }
            };

            await base.Seed(matchId, trump: Suit.Threes, trick: currentTrick);

            // Act
            await _service.PlayDominoAsync(matchId, new Domino(1, 1));

            // Assert
            var match = await DatabaseContext.Matches.FirstOrDefaultAsync(x => x.Id == matchId);
            Assert.NotNull(match);
            Assert.Equal("player1", match.CurrentGame.CurrentPlayerId);
            Assert.Equal(Teams.TeamA, match.CurrentGame.Tricks.Last().Team);
            Assert.Equal("player1", match.CurrentGame.Tricks.Last().PlayerId);
        }
    }
}
