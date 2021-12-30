using System.Collections.Generic;
using FortyTwo.Shared.Models.DTO;

namespace FortyTwo.Client.Store
{
    public class ClientStore : IClientStore
    {
        public List<Match> Matches { get; set; } = new List<Match>();
    }
}
