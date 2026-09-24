using System.Collections.Generic;
using System.Threading.Tasks;
using FortyTwo.Shared.Models;
using Xunit;

namespace FortyTwo.Tests.Characterization
{
    public class StandardGameScenarioTests
    {
        // Doubles first (p1's hand), then the rest in natural rank order.
        private static readonly List<(int, int)> DealOrder = new()
        {
            (0,0),(1,1),(2,2),(3,3),(4,4),(5,5),(6,6),          // p1: all doubles
            (0,1),(0,2),(0,3),(0,4),(0,5),(0,6),(1,2),           // p2
            (1,3),(1,4),(1,5),(1,6),(2,3),(2,4),(2,5),           // p3
            (2,6),(3,4),(3,5),(3,6),(4,5),(4,6),(5,6),           // p4
        };

        [Fact]
        public async Task RunAndWriteFixture()
        {
            var runner = new ScenarioRunner(DealOrder, "standard-game");

            var matchId = await runner.CreateAsync("p1");
            await runner.AddPlayerAsync(matchId, "p2", Teams.TeamB);
            await runner.AddPlayerAsync(matchId, "p3", Teams.TeamA);
            await runner.AddPlayerAsync(matchId, "p4", Teams.TeamB);

            // p1 bids highest (holds all doubles), everyone else passes
            await runner.BidAsync(matchId, "p1", Bid.Thirty);
            await runner.BidAsync(matchId, "p2", Bid.Pass);
            await runner.BidAsync(matchId, "p3", Bid.Pass);
            await runner.BidAsync(matchId, "p4", Bid.Pass);

            await runner.SetTrumpAsync(matchId, "p1", Suit.Sixes);

            // Trick 1: p1 leads 6-6 (trump double, wins), others follow with a six or discard
            await runner.PlayDominoAsync(matchId, "p1", 6, 6);
            await runner.PlayDominoAsync(matchId, "p2", 0, 6);
            await runner.PlayDominoAsync(matchId, "p3", 1, 6);
            await runner.PlayDominoAsync(matchId, "p4", 3, 6);

            // Trick 2: p1 leads 5-5
            await runner.PlayDominoAsync(matchId, "p1", 5, 5);
            await runner.PlayDominoAsync(matchId, "p2", 0, 5);
            await runner.PlayDominoAsync(matchId, "p3", 1, 5);
            await runner.PlayDominoAsync(matchId, "p4", 3, 5);

            // Trick 3: p1 leads 4-4
            await runner.PlayDominoAsync(matchId, "p1", 4, 4);
            await runner.PlayDominoAsync(matchId, "p2", 0, 4);
            await runner.PlayDominoAsync(matchId, "p3", 1, 4);
            await runner.PlayDominoAsync(matchId, "p4", 3, 4);

            // Trick 4: p1 leads 3-3
            await runner.PlayDominoAsync(matchId, "p1", 3, 3);
            await runner.PlayDominoAsync(matchId, "p2", 0, 3);
            await runner.PlayDominoAsync(matchId, "p3", 1, 3);
            await runner.PlayDominoAsync(matchId, "p4", 4, 6); // p4 has no domino of suit Threes (only 3-6, excluded by trump priority) - free to discard trump

            runner.WriteFixture();
        }
    }
}
