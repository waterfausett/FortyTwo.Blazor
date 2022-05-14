using FortyTwo.Server.Exceptions;
using FortyTwo.Server.Services;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;
using System.Collections.Generic;
using Xunit;

namespace FortyTwo.Tests.Server.Services
{
    public class MatchValidationServiceTests
    {
        private readonly MatchValidationService _service;
        public MatchValidationServiceTests()
        {
            _service = new MatchValidationService();
        }

        [Fact]
        public void EveryoneCannotPass()
        {
            // Arrange
            const string currentPlayerId = "player4";
            var game = new Game()
            {
                CurrentPlayerId = currentPlayerId,
                Hands = new List<Hand>
                {
                    new Hand
                    {
                        PlayerId = "player1",
                        Team = Teams.TeamA,
                        Bid = Bid.Pass
                    },
                    new Hand
                    {
                        PlayerId = "player2",
                        Team = Teams.TeamB,
                        Bid = Bid.Pass
                    },
                    new Hand
                    {
                        PlayerId = "player3",
                        Team = Teams.TeamA,
                        Bid = Bid.Pass
                    },
                    new Hand
                    {
                        PlayerId = "player4",
                        Team = Teams.TeamB
                    }
                }
            };

            // Act
            var exception = Assert.Throws<CustomValidationException>(() => _service.ValidateBid(game, (UserId)currentPlayerId, Bid.Pass));

            // Assert
            Assert.NotNull(exception);
        }
    }
}
