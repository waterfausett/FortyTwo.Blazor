using FortyTwo.Shared.Models;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Xunit;

namespace FortyTwo.Shared.Tests
{
    public class TrickTests
    {
        /*
            var currentlyWinningDomino = match.CurrentGame.CurrentTrick.Dominos.Where(x => x != null)
                .OrderByDescending(x => x.GetSuitValue(match.CurrentGame.CurrentTrick.Suit.Value, match.CurrentGame.Trump.Value))
                .First();

         */
        public static IEnumerable<object[]> TestTricks
            => new List<object[]>
            {
                new object[]
                { 
                    new Trick()
                    {
                        Suit = Suit.Aces,
                        Dominos = new Domino[4]
                        {
                            new Domino(1, 6),
                            null,
                            null,
                            null
                        }
                    }
                }
            };

        [Theory]
        [MemberData(nameof(TestTricks))]
        public void Test()
        {

        }
    }
}
